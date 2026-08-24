# Kinopio Phase A / Phase B Todo

本文档是实施清单；设计依据见：

- [可靠性与可观测性设计](./reliability-observability-design.md)
- [Phase A 性能评估与 xjson 退出方案](./xjson-removal-and-phase-a-performance.md)

## Phase A：deadline、清理、观测与双协议迁移基础

### Library 实现

- [x] 将 RPC pending registry 从动态 object 改为 typed `Map<string, PendingCall>`。
- [x] 所有完成路径使用 settle-once，并在完成时删除 Map entry、清理 timer 和 abort listener。
- [x] 增加 opt-in `rpc.defaultTimeoutMs` 和 per-call `timeoutMs`；默认不启用 deadline。
- [x] 增加 per-call `AbortSignal` 取消支持。
- [x] 增加 `rpc.maxInflight`，达到上限时以 `RpcOverloadedError` 拒绝新调用。
- [x] publish 同步异常立即以 `RpcPublishError` settle，`deliveryState=not_sent`。
- [x] channel/connection lost 立即拒绝当前 pending RPC，不等待统一 timeout。
- [x] `close()` 停止 reconnect、拒绝 pending RPC、关闭 event channel/channel/connection。
- [x] 增加 typed errors 与 `DeliveryState`，保留现有远程 `RpcError` 字段。
- [x] 增加 vendor-neutral `KinopioObserver`，observer 异常与业务 RPC outcome 隔离。
- [x] 增加 O(1) `getSnapshot()` 和 `isReady()`；不遍历 pending Map 生成指标。

### JSON/xjson 迁移基础

- [x] 增加 `RpcCallOptions.contentType`，RPC 方法保持原 payload 第一参数，新增 optional 第二参数。
- [x] 增加 `serialization.defaultContentType` 和 `contentTypeByTarget`。
- [x] 固定优先级：per-call > per-target > deprecated `workerCtx.content_type` bridge > client default。
- [x] client default 暂时保持 `application/xjson`，避免发布即改变线上调用。
- [x] response 按实际 AMQP `contentType` 解析，而不是无条件执行 xjson reviver。
- [x] `application/json` 使用 plain `JSON.parse`；合法的 `!!date ...` 等业务字符串不再被修改。
- [x] `application/xjson` 保留 legacy reviver，并对无 legacy tag payload 使用 plain-parse fast path。
- [x] 缺少 content type 时迁移期回退到 xjson；unknown/mismatch 返回 typed serialization error。
- [x] 标准 JSON path 检测并拒绝 Kombu `__type__/__value__` envelope。
- [x] observer event 暴露 request/response bytes、content type/status、decode duration 和 legacy tag type；不暴露 payload、result 或 correlation ID。

### Python serializer 与服务配置

- [x] `platform-common` 增加 `platform_common.serializers.json`。
- [x] 使用 `orjson`；Decimal 转 decimal string，date/datetime 转 ISO/RFC 3339 string。
- [x] decoder 只返回 JSON-native value，不自动恢复 Decimal/date/datetime。
- [x] 验证 Kombu 5.3.7 可直接发布 `orjson.dumps()` 返回的 bytes，无额外 UTF-8 decode copy。
- [x] `platform-common` 版本提升到 `4.0.21` 并固定 `orjson==3.12.0`。
- [x] 18 个 Python service 将 `platform-common` pin 更新到 `4.0.21`。
- [x] 21 个 core/cron Nameko config 注册统一 `json` serializer，原 xjson 默认保持不变。
- [x] contracts 删除同 MIME type 的 ujson registration，并将其原 ujson 默认切换到统一 json serializer。

### 测试与发布

- [x] Kinopio unit tests：success cleanup、timeout、maxInflight、publish error、close。
- [x] Kinopio unit tests：per-call/per-target/default/legacy bridge content type 优先级。
- [x] Kinopio unit tests：JSON/xjson、missing/unknown/mismatch、Kombu marker violation。
- [x] Kinopio unit tests：observer exception isolation。
- [x] platform-common tests：Decimal scale/precision、date/datetime、Unicode、unsupported type、Kombu bytes round-trip。
- [x] Nameko test service 增加真实 `application/json` Decimal/date/datetime RPC contract case。
- [ ] 发布 `platform-common 4.0.21` 制品；服务配置不能先于该制品部署。
- [ ] 在 CI/RabbitMQ + Nameko 环境运行完整 Kinopio integration suite。
- [ ] 发布新的 Kinopio minor version并在 Gateway 升级。
- [ ] Gateway canary 显式配置 `defaultTimeoutMs=30000`、`maxInflight=2000`，默认 content type 仍为 xjson。
- [ ] 运行一周收集 duration、timeout candidate、payload size、decode duration 和 legacy traffic。
- [ ] 按 target 从小型只读 RPC 开始启用 `application/json`，每个 target 保留 xjson rollback switch。

## Phase B：连接状态机、mandatory return 与 backpressure

### Connection supervisor

- [ ] 引入 `ConnectionSupervisor`，每次成功连接分配递增 generation。
- [ ] `connect()` single-flight；并发调用共享同一个连接 Promise。
- [ ] reconnect 使用 exponential backoff + jitter，并支持 explicit heartbeat。
- [ ] 所有 connection/channel/reply-consumer callback 携带 generation；旧 generation callback 不得影响新连接。
- [ ] pending RPC 记录 generation；断连只 settle 对应 generation 的 pending call。
- [ ] reconnect attempts exhausted 进入明确 terminal state，不在 timer callback 中产生 unhandled rejection。

### Publish delivery 与 backpressure

- [ ] RPC publish 启用 confirm channel，并明确 publish confirmed 前后的 `deliveryState`。
- [ ] 启用 `mandatory: true`，处理 broker returned message 并按 correlation ID settle `RpcUnroutableError`。
- [ ] `channel.publish()` 返回 false 后暂停新 publish，等待 `drain`。
- [ ] drain wait 必须有 timeout、连接代次检查和 shutdown 取消路径。
- [ ] observer 增加 confirm latency、unroutable 和 backpressure/drain duration 信号。
- [ ] 保持“不自动 retry RPC”原则；业务层根据 typed error 与幂等性决定是否重试。

### Readiness 与 shutdown

- [ ] reply queue assert/bind/consume 完成后才标记 reply consumer ready。
- [ ] event consumer readiness 纳入 snapshot，并增加 `waitUntilReady()`。
- [ ] Gateway `/readyz` 使用 `kinopio.isReady()`；`/livez` 不依赖 RabbitMQ。
- [ ] graceful shutdown 先停止接收新调用，再等待 bounded drain，超时后拒绝剩余 pending。
- [ ] 与 Kubernetes `terminationGracePeriodSeconds`、preStop 和 Gateway HTTP drain 顺序对齐。

### Phase B 测试与验收

- [ ] fake channel tests：single-flight connect、generation fencing、backoff/jitter 边界。
- [ ] fake channel tests：mandatory return、confirm success/failure、publish false/drain/disconnect。
- [ ] integration tests：broker restart、queue 不存在、reply consumer cancellation、shutdown during inflight。
- [ ] canary 验收：无 reconnect storm、无 pending leak、backpressure 可观测、ready state 与真实消费能力一致。

## 发布约束

- Phase A 的 service config 与 `platform-common 4.0.21` 必须作为同一受控发布链处理。
- Phase A 默认保持 xjson，标准 JSON 只做 caller-driven canary。
- Phase B 不允许只打开 `mandatory: true`；return handler、settle 和 backpressure 必须一起发布。
- 删除 xjson 不属于 Phase A/B 完成条件；必须等 live traffic、retry queue 和 DLQ 连续两个发布周期归零。
