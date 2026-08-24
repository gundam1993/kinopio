# Kinopio 可靠性、生命周期与可观测性优化设计

状态：Proposed  
日期：2026-08-23  
评审范围：`kinopio` v1.7 分支、`projectg-gateway` 实际使用方式、amqplib 0.10.9

## 1. 结论

Kinopio 当前可以完成基本的 Nameko RPC 和事件消费，但可靠性语义还没有形成闭环。最先应该做的不是重写 AMQP 协议层，而是在保持现有调用 API 的前提下补齐四个核心抽象：

1. `PendingCallRegistry`：统一管理 RPC deadline、settle-once、timer、连接断开和 late reply。
2. `ConnectionSupervisor`：用显式状态机区分启动、故障重连和主动关闭。
3. `EventConsumerManager`：让 `reliableDelivery` 真正对应 await handler + ack/nack + prefetch。
4. `KinopioObserver`：输出结构化 RPC、connection、event 和 backpressure 信号，由 Gateway 适配到 Datadog/Sentry/OpenTelemetry。

不建议在 Kinopio 内自动重试 RPC。timeout 或连接断开时，服务端可能已经收到并执行写操作，自动重试会引入重复 booking、payment 或状态变更风险。Kinopio 应返回带 `deliveryState=unknown` 的类型化错误，让上层只对明确幂等操作执行重试。

## 2. 当前使用约束

- Gateway 使用 `kinopio@^1.7.1`，现有构造参数必须兼容。
- Gateway 类型层声明约 628 个 `RpcMethod`，不适合要求逐调用点迁移。
- Gateway 注册约 49 个 Kinopio event handler，主要用于 Redis cache invalidation。
- 当前 event handler 默认参数是 `reliableDelivery=true`、`requeueOnError=false`。
- Gateway 在 `createApp()` 中先 `await kinopio.connect()`，再实例化 `EventHandler`；动态创建的 event channel 没有被应用启动流程 await。
- 生产 Gateway 使用 Node 24；Kinopio 当前构建目标为 CommonJS/ES2018。
- `origin/v2` 是较旧分支，没有包含本设计需要的 deadline、ack、状态机和观测能力，不建议以它作为新实现基线。

## 3. 代码 Review

### 3.1 P1：RPC 没有 deadline，pending resolver 会永久保留

`callRpc()` 创建 Promise 后没有 timer、AbortSignal 或全局 deadline。RabbitMQ 接收请求但回复丢失、reply queue 重建、服务卡死时，调用永远不 settle。

同时，正常响应使用：

```ts
this.rpcResolvers[correlationId] = undefined;
```

key 没有删除；后续重复/晚到消息仍满足 `correlationId in rpcResolvers`，随后调用 `undefined.resolve/reject`。这既是内存增长问题，也是潜在进程异常。

建议：使用 `Map<string, PendingCall>`，所有 response、timeout、abort、disconnect 和 close 都进入唯一的 `settlePendingCall()`。

### 3.2 P1：`reliableDelivery` 与实际消费语义不一致

`createEventHandler()` 无论 `reliableDelivery` 和 `requeueOnError` 是什么，都使用 `noAck: true`；handler Promise 也没有被 await。

实际语义是：

- RabbitMQ 把消息发送给客户端后立即视为完成；
- Redis cache delete 失败或 Gateway 崩溃时，消息不会重投；
- async handler rejection 可能成为 unhandled rejection；
- `requeueOnError` 参数完全没有生效。

Gateway 的 handler 主要是 cache invalidation，因此消息丢失会形成持续的 stale cache，而不是立即可见的异常。

建议：

- `reliableDelivery=true`：`noAck:false`，await handler，成功 ack，失败 nack。
- `reliableDelivery=false`：保留 `noAck:true`，但捕获并上报 handler error。
- 配置 `prefetch`，防止 Redis 慢时 RabbitMQ 无限制推送消息。
- `requeueOnError=true` 只作为基础兼容模式；生产建议使用有最大次数和延迟的 retry/DLQ 策略，避免 hot loop。

### 3.3 P1：主动关闭会触发自动重连

`close()` 关闭 channel/connection，但它们的 `close` listener 无条件调用 `reestablishConnection()`。当前没有 `closing/closed` 状态，也没有取消 reconnect timer。

结果可能是 Pod 正在 graceful shutdown 时又建立 RabbitMQ 连接，延长退出时间或造成资源泄漏。

建议：引入显式生命周期状态；只有 unexpected disconnect 才能进入 reconnect。

### 3.4 P1：连接断开后，旧 RPC 不可能再收到回复，但不会被拒绝

RPC reply queue 是 exclusive + auto-delete。连接丢失后旧 reply queue 被删除，即使 Nameko 已经完成处理，旧调用也无法通过新连接收到回复。

当前重连只重建 connection/channel/queue，没有 reject outstanding calls。它们会永久 pending。

建议：连接 generation 失效时立即以 `RpcConnectionLostError` settle 该 generation 的所有 pending calls。错误必须标记为 `deliveryState: "unknown"`，因为 request 可能已经执行。

### 3.5 P1：连接/channel 恢复模型存在竞争和资源泄漏

当前 connection、主 channel 和每个 event channel 的 `error`/`close` 都会请求完整重连。虽然 `reconnectLock` 限制了部分并发，但仍有以下问题：

- 主动 close 和异常 close 无法区分；
- channel-only failure 会创建新 connection，但旧 connection 可能仍然存活；
- exclusive reply queue 仍被旧 connection 占用时，新 connection 使用相同名称会失败；
- event channel 引用数组从不清理；
- 达到最大尝试次数后从 timer callback 抛出错误，容易成为 unhandled rejection，状态仍然卡在 reconnect lock；
- 计算了线性 `timeout`，实际 `setTimeout` 仍始终使用固定 `reconnectInterval`；
- `connect()`/重连没有 single-flight promise，外部重复调用可创建并行连接。

建议：一个 connection generation 只由 `ConnectionSupervisor` 管理；断线时先使旧 generation 失效、清理引用和 pending calls，再按 exponential backoff + jitter 重建全部 topology。

### 3.6 P2：publish 失败、backpressure 和 unroutable 没有处理

- channel 不存在时先 `reject()`，但没有 `return`，后面仍然执行 `this.channel!.publish()`。
- `JSON.stringify()`、hook 或 `publish()` 同步异常会留下 pending resolver。
- `channel.publish()` 返回 `false` 时表示写缓冲区产生 backpressure，当前完全忽略，峰值流量下可能持续增加内存。
- 没有 `mandatory:true` 和 `return` handler；目标 RPC queue 不存在时只能等到 timeout。
- 普通 channel 没有 publisher confirm。对于 RPC，最终 reply 本身可视为更强的成功信号；对于 one-way event dispatch，没有 confirm 就无法知道 broker 是否接受消息。

建议：

- 序列化和参数校验先于 pending registration。
- channel 不可用时立即返回类型化错误。
- publish 返回 false 后让后续 publish 等待 `drain`。
- RPC request 使用 `mandatory:true`，通过 returned message 按 correlation ID 快速失败。
- RPC 第一阶段不强制 publisher confirm，避免每次调用增加确认延迟；one-way reliable publish 必须使用 confirm channel。

### 3.7 P2：RPC timeout 后 broker 仍可能执行陈旧请求

只在客户端 reject Promise 不能阻止排队中的 RPC 随后执行。

建议在 request message 同时设置：

- AMQP `expiration`：使用剩余 deadline 毫秒字符串；
- header `x-deadline-at`：服务端具备能力后可拒绝已过期工作；
- trace/call ID：用于识别 timeout 后仍完成的请求。

消息已经进入 worker 时无法通过 AMQP 取消，因此写操作仍必须依赖业务幂等。

### 3.8 P2：event handler topology 没有纳入 ready 状态

Gateway 先连接 Kinopio，再构造 EventHandler。decorator 触发的 `createEventHandler()` 是 async，但 class constructor 不会 await 它。重连时又使用 `forEach()` 调用 async 方法而不 await。

因此 Kinopio 可以显示已连接、Gateway 可以开始接流量，但部分 event consumers 仍未建立，或 topology setup 已失败。

建议：将 handler decorator 只用于注册 definition，不做异步副作用；`kinopio.start()` 统一连接并 await 所有 topology。兼容阶段可增加 `await kinopio.waitUntilReady()` 和 expected/ready consumer 计数。

### 3.9 P2：consumer cancellation 和解析错误没有处理

amqplib 在 broker 取消 consumer 时会向 callback 传入 `null`。当前直接调用 `parseMessage(message)`，会抛出异常。JSON/xjson 解析异常也不会 nack、清理或输出结构化错误。

建议：显式处理 `message === null`，将 consumer 标记为 unready 并请求 topology recovery；解析失败按 poison message 策略 nack/DLQ。

### 3.10 P2：观测 hook 上下文不足且可能泄露敏感数据

当前 `onResponse(result)` 没有 target、method、duration、outcome 和 correlation ID。Gateway 则把完整 RPC request payload 和 response result 写进 Sentry breadcrumb。

这会带来 PII、payment data、payload 体积和序列化开销风险。

建议 hook 只输出结构化 metadata；payload 采集默认关闭，调试时通过 sanitizer + sampling 临时开启。

### 3.11 P2：测试覆盖无法保护可靠性改造

现有测试覆盖 happy-path RPC、远程异常、xjson、worker context 和基础 hook，但没有覆盖：

- timeout、late response 和 resolver cleanup；
- connection/channel loss；
- close 后不得 reconnect；
- backpressure、mandatory return、publish throw；
- event ack/nack、async rejection、prefetch、consumer cancellation；
- topology 恢复和多次 reconnect；
- observer 自身抛错不能影响业务。

OpenTelemetry 的两个 `context.with(..., async () => ...)` 测试没有 await callback 返回值，可能在断言完成前结束，属于潜在假阳性。

### 3.12 P3：维护性问题

- `reconnectMaxAttemptes` 拼写错误且已进入公共 API。
- `connect(): Promise<RpcContext>` 实际没有 return。
- `rpcResolvers`、handler、logger 大量使用 `any`。
- `new Buffer()` 已废弃，应使用 `Buffer.from()`。
- README 只有安装命令，没有可靠性语义、生命周期和错误说明。
- CI 仍声明 Node 8/10/12，而 Gateway 生产镜像使用 Node 24。
- 项目同时保留 yarn/pnpm lockfile，`prepare` 使用 pnpm，CI 使用 npm，容易产生不可复现依赖。
- Gateway 实际安装的是 `kinopio@1.7.1`，但其发布产物与本地被忽略的 `dist` 不一致；CI 当前没有验证 `npm pack` 后的 tarball 内容，存在“源码已修复但消费方拿到不同产物”的风险。

## 4. 设计目标与非目标

### 4.1 目标

- 不修改绝大多数现有 Gateway RPC 调用点。
- 每个 RPC 在有限时间内以且仅以一种 outcome 结束。
- 连接断开、主动关闭和重连行为可预测、可观测、可测试。
- reliable event 至少做到 at-least-once；重复消息由 handler 幂等处理。
- 为 Datadog 告警提供可信的 duration、outcome、in-flight 和 connection 信号。
- 监控/observer 故障不能影响业务 RPC。

### 4.2 非目标

- 不在 Kinopio 内实现通用分布式事务或 exactly-once。
- 不自动重试语义不明的 RPC。
- 第一阶段不更换 Nameko RPC wire protocol。
- 第一阶段不引入新的 tracing backend。
- 不把 RabbitMQ broker 指标采集放进 Kinopio。

## 5. 建议内部架构

```text
RpcProxy
   |
   v
RpcClient ----------------------> KinopioObserver
   |                                   ^
   +--> PendingCallRegistry -----------+
   |       - deadline timer
   |       - settle once
   |       - connection generation
   |
   +--> RpcPublisher
           - readiness gate
           - mandatory return
           - backpressure
           - message expiration

ConnectionSupervisor
   - state machine
   - connection generation
   - reconnect backoff/jitter
   - topology restore
   - graceful close
        |
        +--> ReplyConsumer
        +--> EventConsumerManager
        +--> ReliableEventPublisher
```

这些组件第一版可以仍在少量文件中实现，不要求立即拆成多个 npm package；但状态和职责必须在类型层分开。

## 6. 生命周期状态机

```text
IDLE -> CONNECTING -> READY
             |         |
             v         v
          RETRY_WAIT <- DISCONNECTED
             |
             +-------> CONNECTING

IDLE/CONNECTING/READY/RETRY_WAIT
             |
             v
          CLOSING -> CLOSED
```

规则：

1. `connect()` 是 single-flight；并发调用返回同一个 Promise。
2. 每次成功连接产生递增 `generation` 和新的 reply queue identity。
3. 非预期断线只处理当前 generation；旧 listener 不得影响新连接。
4. 断线先将 state 设为 disconnected，再 reject 当前 generation 的 pending calls，最后调度 reconnect。
5. `close()` 先切到 closing、停止新调用、取消 reconnect timer，再按配置等待 in-flight，最后关闭 consumers/channels/connection。
6. closing/closed 状态下所有 close/error event 都不得重连。
7. reconnect 默认无限尝试并采用 capped exponential backoff + jitter；如果选择有限次数，耗尽后进入 FAILED 并通过回调决定进程退出，而不是从 timer 中裸 throw。

建议默认值：

```text
initialDelayMs = 500
maxDelayMs = 30000
multiplier = 2
jitterRatio = 0.2
heartbeatSeconds = 30
```

## 7. RPC 生命周期

### 7.1 PendingCall

```ts
interface PendingCall<T = unknown> {
  correlationId: string;
  target: string;
  method: string;
  startedAt: number;
  deadlineAt: number;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: T) => void;
  reject: (error: KinopioError) => void;
}
```

### 7.2 settle-once

所有结束路径调用同一个内部方法：

```ts
settlePendingCall(correlationId, outcome, valueOrError)
```

它必须原子地：

1. 从 Map 取得并删除 pending call；
2. 清理 timer；
3. emit observer finish event；
4. resolve 或 reject；
5. 如果 key 已不存在，记录 `late_reply` 或 `duplicate_reply`，不得抛错。

### 7.3 调用顺序

```text
validate and serialize
  -> verify READY and maxInflight
  -> calculate deadline
  -> register PendingCall
  -> publish mandatory message with expiration
  -> wait for reply / timeout / abort / disconnect
  -> settle once
```

如果 publish 同步抛错，必须立即 settle 为 `publish_error`。publish 返回 false 不代表该消息失败，只表示后续 publish 需要等待 `drain`。

### 7.4 Error taxonomy

```ts
type DeliveryState = 'not_sent' | 'confirmed' | 'unknown';

class RpcTimeoutError extends KinopioError {
  code = 'RPC_TIMEOUT';
  deliveryState: DeliveryState = 'unknown';
}

class RpcConnectionLostError extends KinopioError {
  code = 'RPC_CONNECTION_LOST';
  deliveryState: DeliveryState = 'unknown';
}

class RpcNotReadyError extends KinopioError {
  code = 'RPC_NOT_READY';
  deliveryState: DeliveryState = 'not_sent';
}

class RpcUnroutableError extends KinopioError {
  code = 'RPC_UNROUTABLE';
  deliveryState: DeliveryState = 'not_sent';
}

class RpcOverloadedError extends KinopioError {
  code = 'RPC_OVERLOADED';
  deliveryState: DeliveryState = 'not_sent';
}
```

现有 `RpcError` 继续代表 Nameko 返回的远程异常，不改变 `remoteName/remoteArgs/remoteFullName`。

## 8. 公共 API 设计

### 8.1 兼容构造参数

保留现有 flat AMQP 参数，新增 optional block：

```ts
interface KinopioConfig {
  hostname?: string;
  port?: number;
  vhost?: string;
  username?: string;
  password?: string;
  heartbeatSeconds?: number;

  rpc?: {
    defaultTimeoutMs?: number;
    maxInflight?: number;
    mandatory?: boolean;
  };

  serialization?: {
    defaultContentType?: RpcContentType;
    contentTypeByTarget?: Record<string, RpcContentType>;
  };

  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitterRatio?: number;
    maxAttempts?: number;
  };

  events?: {
    defaultPrefetch?: number;
  };

  observer?: KinopioObserver;

  /** @deprecated Use reconnect.maxAttempts. */
  reconnectMaxAttemptes?: number;
}
```

### 8.2 兼容 RPC 调用

已有调用保持不变：

```ts
await rpc.bookings.get_booking({ kwargs: { bookingId } });
```

增加 optional 第二参数：

```ts
type RpcContentType = 'application/xjson' | 'application/json';

interface RpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  contentType?: RpcContentType;
}

export type RpcMethod<T = unknown> = (
  payload?: RpcPayload,
  options?: RpcCallOptions,
) => Promise<T>;
```

长任务才显式覆盖：

```ts
await rpc.reports.generate_report(
  { kwargs: input },
  { timeoutMs: 60_000, signal: requestAbortSignal },
);

await rpc.locations.list_countries(
  {},
  { contentType: 'application/json' },
);
```

### 8.3 状态 API

```ts
interface KinopioSnapshot {
  state: ConnectionState;
  generation: number;
  pendingRpc: number;
  replyConsumerReady: boolean;
  readyEventConsumers: number;
  expectedEventConsumers: number;
  reconnectAttempts: number;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
}

kinopio.isReady(): boolean;
kinopio.getSnapshot(): KinopioSnapshot;
kinopio.waitUntilReady(options?): Promise<void>;
```

Gateway `/readyz` 使用 `isReady()`；`/livez` 不调用 RabbitMQ；真实 Bookings RPC 放到独立 synthetic。

## 9. Event consumer 设计

### 9.1 Definition 与 runtime 分离

Decorator 只登记 `EventHandlerDefinition`：

```ts
interface EventHandlerDefinition {
  sourceService: string;
  eventType: string;
  handlerType: EventHandlerType;
  handlerName: string;
  reliableDelivery: boolean;
  requeueOnError: boolean;
  prefetch?: number;
  handler: (payload: unknown, headers: unknown) => Promise<void> | void;
}
```

ConnectionSupervisor 在每个 generation 内 await：exchange -> queue -> binding -> qos -> consume。只有 expected consumers 全部 ready 后，Kinopio 才进入 READY。

### 9.2 Ack policy

```text
reliableDelivery = false
  noAck = true
  catch handler error -> metric/log only

reliableDelivery = true
  noAck = false
  await handler
  success -> ack
  failure + requeueOnError=false -> nack(requeue=false)
  failure + requeueOnError=true -> nack(requeue=true)
```

生产最终形态应增加 retry/DLQ policy：

```ts
retry?: {
  maxAttempts: number;
  delayMs: number[];
  deadLetterExchange: string;
};
```

不要仅靠 `redelivered` boolean 计算次数；需要 broker retry/DLX 的 `x-death` 或显式 attempt header。

### 9.3 Gateway handler 前置修复

切换 manual ack 前先检查 handler 幂等性。当前 cache delete 基本天然幂等，适合 at-least-once；但 `roomUpdated()` 中的 `rooms.map(async ...)` 没有 await `Promise.all`，需要先修复，否则 Kinopio 即使 await 外层 handler，也无法等待内部删除完成。

## 10. Observer 与指标

Kinopio 保持 vendor-neutral，只注入一个 observer。observer 抛出的任何错误都必须被吞掉并记录内部计数，不能改变 RPC outcome。

```ts
interface KinopioObserver {
  onConnectionStateChange?(event: ConnectionStateEvent): void;
  onRpcStart?(event: RpcStartEvent): void;
  onRpcFinish?(event: RpcFinishEvent): void;
  onEventFinish?(event: EventFinishEvent): void;
  onPublishBackpressure?(event: BackpressureEvent): void;
  onLateReply?(event: LateReplyEvent): void;
}
```

建议指标：

```text
kinopio.connection.ready
kinopio.connection.reconnects
kinopio.connection.downtime_seconds
kinopio.rpc.calls
kinopio.rpc.duration_seconds
kinopio.rpc.inflight
kinopio.rpc.timeouts
kinopio.rpc.late_replies
kinopio.rpc.unroutable
kinopio.publish.backpressure
kinopio.event.processed
kinopio.event.duration_seconds
kinopio.event.redelivered
kinopio.event.consumer_ready
```

允许的 tags：

```text
client_service
target_service
method
outcome
event_source
event_type
handler
```

禁止的 metric tags：correlation ID、call ID、user ID、booking/property ID、完整 routing payload。

Gateway 的 Sentry breadcrumb 改成 metadata-only：target、method、outcome、duration bucket；默认不写 payload/result。需要 payload 调试时必须经过 sanitizer 和 sampling。

## 11. 由 Kinopio 指标驱动的首批告警

| 告警 | Bootstrap 条件 | 等级 |
|---|---|---|
| KinopioDisconnected | `connection.ready=0` 持续 1 分钟 | P1/P2，按 Gateway 可用性合并 |
| KinopioReconnectStorm | reconnect > 3 次/5 分钟 | P2 |
| RpcTimeoutRatio | Tier 0 target timeout > 1%，calls > 20，持续 5 分钟 | P1/P2 |
| RpcInflightLeak | inflight 连续增长 10 分钟且 response rate < request rate | P1 |
| RpcInflightCapacity | inflight > maxInflight 的 80%，持续 5 分钟 | P2 |
| RpcLateReply | late reply > 0 且持续出现 | P2，表示 timeout budget 或服务延迟失配 |
| PublishBackpressure | drain wait 持续出现且 p95 > 100 ms | P2 |
| EventConsumerMissing | ready consumers < expected consumers 2 分钟 | P1/P2 |
| ReliableEventFailure | reliable handler failure/requeue 持续升高 | P2 |

这些告警应与 RabbitMQ broker/root-cause 告警做抑制：RabbitMQ cluster P1 激活时，不为每个 Kinopio target 单独 paging。

## 12. 分阶段实施

### Phase A：最小可落地版本，建议 5–8 个开发日

目标：优先解决用户提到的 timeout、cleanup 和指标，保持现有调用方式。

1. `rpcResolvers` 改为 typed Map/PendingCall。
2. 增加 optional `rpc.defaultTimeoutMs`，先由 Gateway 显式配置，library 默认暂时 disabled 或较大值。
3. 在 `RpcCallOptions` 增加显式 `contentType`，支持 per-call 和 per-target override；不再把协议选择混入 `workerCtx`，旧字段只保留 deprecated bridge。
4. pending call 保存 expected content type；response 按消息实际 `properties.contentType` 解码，并对 mismatch、missing 和 unknown 分别计数/报 typed error。
5. 正常 response、timeout、connection lost、close、publish error 全部走 settle-once。
6. 增加类型化错误和 `deliveryState`，不自动 retry。
7. 增加 observer、snapshot、in-flight、connection state、wire content type、payload bytes 和 decode duration metrics。
8. 增加 optional `rpc.maxInflight`，用 O(1) registry size 检查保护 event loop 和 heap。
9. `close()` 设置 closing flag、取消 reconnect、拒绝/等待 pending calls。
10. 在 `platform-common` 增加基于 orjson 的标准 JSON encoder：Decimal 输出 string，date/datetime 输出 ISO string；所有 Python 服务先注册该 encoder，但默认 outgoing serializer 暂时仍为 xjson。
11. 添加 Kinopio unit tests 和 RabbitMQ + Nameko serializer contract tests。

建议 Gateway 首次设置：

```ts
rpc: {
  defaultTimeoutMs: 30_000,
  maxInflight: 2_000,
},
serialization: {
  defaultContentType: 'application/xjson',
}
```

先运行一周收集 duration 和 timeout candidate，再按 operation/RPC 分布把普通请求下调到 10 秒。不能直接假设所有 628 个 RPC 都适合统一 10 秒。

`mandatory:true` 只有与 returned-message handler、correlation settle 和 publish backpressure 一起实现才有意义，因此仍在 Phase B 启用，不能只在 Phase A 提前打开属性位。

Phase A 的 steady-state 性能量级、验收预算，以及 xjson 的额外 decode 成本见 [Phase A 性能评估与 xjson 退出方案](./xjson-removal-and-phase-a-performance.md)。

实施状态与发布前置条件见 [Phase A / Phase B Todo](./phase-a-b-todo.md)。

### Phase B：连接状态机与 backpressure，建议 3–5 个开发日

1. ConnectionSupervisor + generation + single-flight connect。
2. exponential backoff + jitter + explicit heartbeat。
3. 将 Phase A 的 pending-call failure 纳入 generation-aware disconnect 流程。
4. mandatory return 和 backpressure/drain。
5. reply consumer readiness 和 `/readyz` 接入。
6. graceful close/drain 与 Kubernetes termination 配合。

### Phase C：事件可靠性，建议 3–5 个开发日

1. decorator definition 与 runtime topology 分离。
2. await 全部 topology setup 后 READY。
3. manual ack/nack、prefetch、consumer cancellation。
4. 修复/验证 Gateway handler 幂等与 async completion。
5. stage 开启 manual ack，观察 backlog/redelivery 后再逐步生产启用。
6. 第二步再引入 bounded retry + DLQ，避免一次改动过大。

### Phase D：API 和工程治理

1. 发布 v1.8 opt-in 能力并在 Gateway canary。
2. 发布 v2 时启用默认 finite deadline、修正 `connect()` 返回类型和拼写错误。
3. Node CI 更新到生产支持版本，固定单一 package manager/lockfile。
4. README 补充 delivery semantics、error taxonomy、timeouts、shutdown 和 metrics。
5. CI 执行 `npm pack`，在临时 consumer 中安装生成的 tarball，再运行 typecheck/smoke test；发布和 Gateway 升级都以 tarball 校验结果为准。

## 13. 测试策略

### 13.1 Unit tests：fake timers + fake channel

- response before deadline；
- timeout 后 Map 为空；
- late/duplicate reply 不抛错；
- publish throw、channel missing 和 JSON serialization failure；
- connection lost 立即 reject 当前 generation；
- close 不触发 reconnect；
- reconnect single-flight、backoff 和 jitter 边界；
- publish false 后等待 drain；
- observer 抛错不影响调用；
- maxInflight 拒绝新请求。

### 13.2 Event tests

- sync/async handler 成功后 ack；
- handler throw/reject 后按策略 nack；
- `reliableDelivery=false` 保持 noAck；
- prefetch 被设置；
- null message 将 consumer 标为 unready；
- reconnect 后 topology 恰好恢复一次；
- duplicate definition 明确报错，不能静默覆盖。

### 13.3 Integration tests：RabbitMQ + Nameko

- 正常 RPC 和远程错误保持兼容；
- 停止 Nameko consumer 触发 timeout；
- RPC 处理中断开 Kinopio connection，得到 connection-lost unknown-delivery；
- 目标 routing key 不存在时 mandatory return；
- handler 第一次失败、第二次成功，验证 redelivery；
- Gateway canary 在 RabbitMQ node replacement 后自动恢复。

## 14. 发布与回滚

1. 先发布只采集 observer/snapshot 的版本，不启用强制 timeout。
2. Gateway 单 Pod canary 开启 30 秒 timeout，比较 RPC duration、GraphQL error 和 in-flight。
3. 对超过 30 秒的 RPC 建 explicit allowlist/override；确认写操作的幂等策略。
4. 扩到全部 Gateway Pod；保留一键关闭 timeout 的 feature flag 一个发布周期。
5. event manual ack 单独发布，先 stage，再单 Pod canary；回滚开关恢复 legacy noAck。
6. 指标稳定后删除 legacy 模式，并在 major version 中启用安全默认值。

回滚不能恢复已经重复执行的写请求，因此方案从一开始就禁止隐式 RPC retry。

## 15. ADR-002：Kinopio 使用有限 deadline、显式连接状态和 at-least-once event

### Status

Proposed

### Context

Kinopio 是 Gateway 到 Nameko 的统一 RPC 入口，覆盖约 628 个声明方法和约 49 个 Gateway event handler。当前无限等待、隐式重连和 auto-ack 无法提供可定义的错误率、延迟或可靠投递语义。

### Decision

- RPC 使用有限 deadline 和 settle-once registry。
- 连接由 generation-based state machine 管理。
- 连接丢失时 pending RPC fail fast，delivery state 标为 unknown。
- Kinopio 不自动重试 RPC。
- reliable event 使用 manual ack，提供 at-least-once 而非 exactly-once。
- 指标通过 vendor-neutral observer 输出。

### Positive consequences

- 所有 RPC 有界结束，可计算 timeout/error SLI。
- 不再因 resolver/连接泄漏造成长期内存增长。
- event handler 失败能够重投或进入 DLQ。
- Gateway readiness 和告警可以依赖明确状态。

### Negative consequences

- timeout 会暴露既有慢 RPC，短期可能增加可见错误。
- at-least-once 会产生重复事件，handler 必须幂等。
- connection state、pending registry 和 topology recovery 增加内部代码量。
- manual ack 后 Redis/handler 故障会形成可见 backlog，需要容量和 DLQ 告警。

### Alternatives considered

1. 只在 GraphQL resolver 外包 `Promise.race`：无法清理 Kinopio resolver，也无法处理连接 generation、late reply 和 AMQP expiration。
2. 自动 retry timeout RPC：对非幂等写存在重复执行风险，不采用。
3. 完全迁移到新的 RPC 框架：改动 628 个声明方法和大量 resolver，当前收益/风险比不合理。
4. 仅依赖 RabbitMQ queue alerts：无法识别 reply 丢失、in-flight leak、无积压的慢 RPC 和 client disconnect。

## 16. 当前验证说明

- 已完整审阅 v1.7 `lib/index.ts`、现有测试、Gateway middleware/event handlers、git 历史和 `origin/v2`。
- 已通过 Context7 核对 amqplib 当前 channel publish/backpressure、manual ack/nack、consumer cancellation、confirm channel 和 channel close 语义。
- 已使用项目对应的 Node 22 runtime 执行 TypeScript `--noEmit` 验证，当前源码通过。默认 shell 会优先找到 `/usr/local/bin/node` 7.7.2，而不是 `NVM_BIN` 中的 Node 22；CI/本地脚本需要固定 runtime，避免环境漂移。
