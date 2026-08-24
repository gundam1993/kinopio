# Kinopio Phase A 性能评估与 xjson 退出方案

## 1. 结论

1. Phase A 的 steady-state 开销很小。`Map + timeout timer + settle-once + no-op observer` 的本地合成基准低于 `0.5 us/RPC`；在 2,000 个 pending RPC 下，registry 和 timer 的估算内存约 `0.54 MiB`。相对于 RabbitMQ 网络、Nameko worker、数据库和 GraphQL resolver 延迟，这部分通常不可见。
2. Phase A 中真正可能引入性能风险的不是 timeout，而是错误的指标实现：同步 exporter、每次 RPC 输出日志、记录 payload/result、或使用高基数 label。Observer 必须是同步轻量、无网络 I/O、无 payload，实际导出由 SDK 批处理。
3. xjson 的问题不只是非标准 MIME type。它在 Python-to-Python 和 Python-to-Node 两条链路上具有不同的类型语义，而且当前 Kinopio 不检查 `contentType`，会对所有 JSON 响应执行 legacy reviver。
4. 不应直接把服务配置从 `xjson` 改成 Kombu `json`。项目锁定的 Kombu 5.3.7 会把 `datetime/date/Decimal` 编码成 `{"__type__": ..., "__value__": ...}`；Gateway 的 `camelizeKeys` 又会把它改成 `{type, value}`，形成静默破坏。
5. 目标协议应是标准 `application/json`，并且 RPC/event DTO 在进入 serializer 前只允许 JSON-native value。日期和金额的语义由字段契约定义，不再由字符串前缀或通用 reviver 猜测。
6. 推荐采用 caller-driven 的逐 target 迁移。Nameko 3.0.0rc11 的 RPC response 根据 request `content_type` 在响应服务本地反查 serializer，因此 Kinopio 可以按 service/method 切换 xjson/JSON wire family；但同一 MIME type 可被不同 codec 复用，不能把它理解为严格沿用请求方的 serializer 名称。
7. Phase A 应同时加入 Kinopio per-call/per-target content type，以及 Python 侧统一 JSON encoder；否则 Node 虽然能选择 `application/json`，不同 Python 服务仍可能返回 Kombu marker、ujson number 或 serialization error。

## 2. Phase A 对性能的影响

### 2.1 评估范围

这里的 Phase A 指：

- `rpcResolvers` 从持续留下 tombstone 的 object 改为 typed `Map`；
- finite timeout 和成功后的 `clearTimeout`；
- normal response、timeout、publish failure、connection lost 和 close 共用 settle-once；
- typed error 和 delivery state；
- O(1) snapshot、in-flight counter、connection state；
- vendor-neutral observer；
- optional `maxInflight`；
- graceful close 时停止接收并处理 pending call。

`mandatory return`、publish backpressure/drain 和 reconnect state machine 仍属于 Phase B。仅设置 `mandatory: true` 而不处理 returned message 没有可靠性收益，因此不能提前放进 Phase A 的 Gateway 配置。

### 2.2 本地微基准

运行环境：Node.js 22.17.1，单进程 synthetic loop；数据仅用于判断数量级，不替代生产压测。

| Registry 路径 | 中位 CPU 时间/调用 |
|---|---:|
| 当前 object：insert -> lookup -> 写 `undefined` | 320 ns |
| `Map`：set -> get -> delete | 72 ns |
| `Map` + set/clear timeout + settle-once | 379 ns |
| 上述路径 + 两个时间戳/轻量 no-op observer | 407 ns |

这里的百分比没有意义：基数太小，而且当前 object 会持续积累随机 UUID key，微基准反而低估了它运行数天后的劣化。更有意义的结论是，Phase A 本身仍处于亚微秒级。

100,000 个 synthetic pending call 的 heap 增量折算约为 `285 bytes/pending`，即 2,000 个约 `0.54 MiB`。实际对象、闭包和 telemetry SDK 会使数字略高，因此验收预算可保守设为：

- `maxInflight=2,000` 时 Kinopio pending registry 增量小于 5 MiB；
- 相同流量下 Gateway CPU 增量小于 2%；
- GraphQL/RPC p95 增量小于 1%；
- event-loop-delay p99 增量小于 1 ms。

### 2.3 各项开销判断

| 改动 | steady-state 影响 | 说明 |
|---|---|---|
| object -> `Map` | 小幅改善 | 删除 entry 后不留下 tombstone；动态 UUID key 对 `Map` 更合适 |
| 每次 RPC 一个 timer | 极小 CPU、线性小内存 | 正常 response 必须立即 `clearTimeout` |
| settle-once | 极小 | 一次 boolean/状态判断，避免重复 resolve/reject |
| typed error | 仅错误路径 | 不影响成功调用 |
| snapshot/counter | 极小 | 必须维护 O(1) counter，不能每次 scrape 遍历 pending Map |
| observer | 取决于 adapter | 禁止同步网络、payload、动态 label 和每调用日志 |
| maxInflight | 极小 | 一个 size 比较；过载时反而保护 event loop 和 heap |
| graceful close | 无正常路径开销 | 只在 shutdown/disconnect 扫描 pending |

### 2.4 Observer 的性能护栏

Kinopio 只调用接口，不直接绑定 Datadog、Sentry 或 OpenTelemetry exporter：

```ts
observer?.onRpcFinish({
  service,
  method,
  outcome,
  durationMs,
  deliveryState,
});
```

必须满足：

- callback 不得返回 Promise，Kinopio 不 await；
- callback exception 被隔离，不能改变 RPC outcome；
- 不传 payload、result、完整 error stack 或 correlation ID 作为 metric label；
- service/method 是受控维度，用户 ID、booking ID 等不能成为 label；
- exporter 使用 SDK 内存聚合和 batch export，不能每次 RPC 发 HTTP；
- duration 使用 monotonic clock；snapshot 的 counter 在状态变化时更新。

### 2.5 Canary 验收

先发布 observer/snapshot、但不启用 deadline；再对单 Gateway Pod 开启 `30s` timeout 和 `2,000` max inflight。比较相同流量窗口的：

- process CPU、RSS、heap used、GC pause；
- event-loop delay；
- RPC calls/duration/error/timeout/inflight；
- GraphQL p95/p99/error rate；
- timeout 后 late reply 数量。

只有当生产 telemetry 证明长任务有明确分布后，才把普通 RPC 从 30 秒下调；长任务通过 per-call override 明确声明。

## 3. 当前 xjson 的真实协议

### 3.1 Python 编码

`platform_common.xjson` 把以下对象编码为普通 JSON string：

| Python 类型 | wire value |
|---|---|
| `datetime` | `"!!datetime <isoformat>"` |
| `date` | `"!!date <isoformat>"` |
| `Decimal` | `"!!decimal <decimal>"` |
| `set` | `"!!set <python repr>"` |

Python decoder 再把 dictionary value 还原为原类型。

### 3.2 Kinopio 编码与解码

Kinopio request body 实际一直是 `JSON.stringify({args, kwargs})`，但默认声明为 `application/xjson`。它没有实现 xjson encoder：

- JavaScript `Date` 会被 JSON 自身转成 ISO string，不带 tag；
- `BigInt` 仍无法 JSON.stringify；
- 没有 Decimal/set 类型编码。

response 端使用 `JSON.parse(raw, parseXJson)`：

- 只移除 `datetime/date/decimal` 三种前缀；
- 不还原 JavaScript 类型，全部仍是 string；
- 不支持 `!!set`；
- 不检查 AMQP `contentType`，包括真正的 `application/json`/ujson 都执行相同 reviver。

### 3.3 Nameko response 跟随 request content type，而非 serializer identity

Nameko 3.0.0rc11 `Responder.send_response()` 的实际逻辑是：

```python
content_type = request.properties["content_type"]
serializer = local_registry.type_to_name[content_type]
```

因此 response 使用的是“响应服务本地 registry 中映射到该 content type 的 serializer”，不保证与请求方使用相同的 serializer name/encoder。

对当前大多数服务：

```text
Kinopio request application/xjson
  -> local registry application/xjson -> xjson
  -> Nameko xjson decode
  -> service method
  -> Nameko xjson response

Kinopio request application/json
  -> local registry application/json -> json
  -> Nameko Kombu json decode
  -> service method
  -> Nameko Kombu json response
```

但是 contracts core 又注册了：

```yaml
ujson:
  content_type: application/json
```

注册后，该进程中的反向映射会变成 `application/json -> ujson`，同时 `application/json` decoder 也会被 `ujson.loads` 覆盖。因此向 contracts 发送 `application/json` 时，response 使用 ujson，而不是 Kombu builtin json。

本地对锁定版本 ujson 5.8.0 的验证还显示：`Decimal("12.30")` 被编码成 JSON number `12.3`，而 date/datetime 直接报不可序列化。这进一步说明 content type 只能选择 xjson/JSON 表示族，不能替代 JSON-native DTO contract。

服务自身的 `serializer:` 配置主要决定它作为 caller/event producer 时的默认输出；RPC response 则按 request content type 做上述本地反查。

### 3.4 当前配置覆盖面

在仓库的 21 个 deploy config 中：

- 17 个默认 `serializer: xjson`；
- 3 个 cron 默认 `serializer: json`；
- contracts core 默认 `serializer: ujson`；
- 21 个都注册 `application/xjson`，且 `ACCEPT` 同时包含 `json` 和 `xjson`。

这意味着 dual-read 的基础已经存在，但 producer/caller 仍以 xjson 为主。

另一个发布治理风险是：当前 `platform-common` master 的 `setup.py` 版本为 4.0.16，但各服务依赖分布在 4.0.11、4.0.12、4.0.14 和 4.0.20，仓库中没有可直接把这些 package version 映射到 commit 的 tags。当前 xjson 文件最后一次功能修改可追溯到 2022 年，但正式迁移前仍应从制品库取得线上实际 wheels，用相同 golden vectors 验证，而不能只以 workspace master 代替生产制品。

## 4. Code review 发现

### 4.1 P1：content-type blind reviver 会改变合法业务字符串

任何以 `!!date `、`!!datetime ` 或 `!!decimal ` 开头的普通字符串都会被 Kinopio 静默截断。Python decoder 更进一步，会把 dictionary 中的相同字符串变成 Python 对象。

这不是罕见输入才会触发的 parser bug，而是协议没有区分“业务字符串”和“类型标记”。

### 4.2 P1：直接切换 Kombu json 会静默改变 response shape

Kombu 5.3.7 标准 JSON serializer 对特殊类型使用 object envelope：

```json
{
  "__type__": "decimal",
  "__value__": "12.30"
}
```

当前 Kinopio 不解码这个 envelope；Gateway 的 `camelizeKeys` 会继续把它改成：

```json
{
  "type": "decimal",
  "value": "12.30"
}
```

所以“把 config 中的 xjson 改为 json”不是兼容迁移，会把原先 Gateway 得到的 `"12.30"` 变成 object。

仓库已有具体风险：`billing.cancel_payment_items` 返回由 `round_decimal()` 产生的两个 `Decimal`，Gateway 当前把它们当 string/number-like value 使用。该 RPC 在切换前必须先显式输出 decimal string。

### 4.3 P1：Python 与 Node 的 decode 规则不等价

Python `object_hook` 只处理 dictionary value，不处理 list 中的 primitive：

```text
{"date": "!!date 2026-08-23"}       -> Python date
{"dates": ["!!date 2026-08-23"]}   -> Python string
```

JavaScript JSON reviver 会处理两者，但只去掉前缀并保留 string。相同 wire payload 因语言和容器位置产生不同类型。

### 4.4 P1：`set` 是 Python 私有语义

`set` 使用 Python repr + `ast.literal_eval`：

- wire 顺序不稳定；
- Node 不支持；
- JSON consumer 无法从 schema 判断其语义；
- 空 set 还有单独特殊分支。

如果业务字段是集合，wire contract 应使用 array，并由字段契约规定去重和排序。

### 4.5 P2：缺少 datetime/decimal 边界规范

当前协议允许 naive datetime，未规定 UTC、offset、精度和 `Z`；Decimal 虽避免了 float 精度丢失，但这是依赖前缀的偶然结果。应把规则提升为显式契约：

- `date`: `YYYY-MM-DD` string；
- `datetime`: RFC 3339 string，必须带 offset，跨服务默认 UTC；
- `decimal/money`: base-10 string，保留业务要求的 scale；
- `set`: deterministic JSON array。

### 4.6 P2：xjson decode 是可见的 CPU 税

本地 synthetic benchmark：

| Payload | plain JSON parse | xjson parse | plain + camelize | xjson + camelize |
|---:|---:|---:|---:|---:|
| 12.8 KB | 0.029 ms | 0.217 ms | 0.155 ms | 0.339 ms |
| 128.7 KB | 0.272 ms | 2.086 ms | 1.534 ms | 3.391 ms |
| 1.30 MB | 2.707 ms | 20.952 ms | 15.735 ms | 37.480 ms |

即使约 115 KB payload 完全没有 legacy tag，Node reviver 仍从约 `0.304 ms` 增到 `2.043 ms`，因为 JSON reviver 会访问树中的每个 value。

Python 侧约 124 KB、无 tag payload：

- `json.loads`: `0.529 ms`；
- `xjson.decode`: `1.585 ms`；
- encode 两者均约 `0.77 ms`。

这些是本机微基准，不应直接替代生产 p95；但它证明 xjson decode 是 O(payload tree size) 的真实额外遍历。历史 CPU profile 中 `parseMessage` 对大响应也是可见热点，只是 profile sampling gap 使部分 86–412 ms apparent sample 不能全部归因给 parser。

## 5. 目标 wire contract

### 5.1 核心规则

最终只使用：

```text
Content-Type: application/json
Content-Encoding: utf-8
```

RPC request、response 和 event payload 在 serializer 边界只能包含：

- `null`；
- boolean；
- finite JSON number；
- string；
- array；
- object with string keys。

禁止 serializer 自动推断/恢复 domain type。类型属于 method schema，而不是属于任意字符串值。

### 5.2 类型映射

| Domain type | JSON contract | Python 内部恢复位置 | Node 使用方式 |
|---|---|---|---|
| datetime | RFC 3339 string with offset | input schema/DTO mapper | string，必要时 resolver 显式 parse |
| date | `YYYY-MM-DD` string | input schema/DTO mapper | string |
| Decimal/money | decimal string | `Decimal(value)` 或 schema field | decimal.js/string，禁止隐式 JS float |
| set | deterministic array | `set(values)` 仅在 domain 层 | array |

不建议让 Kinopio 支持 Kombu `__type__/__value__` envelope。那只是把一套非标准 type magic 换成另一套，并继续使 Node transport client 知道 Python serializer 的私有实现。

### 5.3 Python 标准 JSON encoder

不建议继续把兼容 encoder 命名为 ujson。项目锁定的 ujson 5.8.0 虽支持 `default` callback，但 Decimal 被 ujson 原生处理，不会进入 callback：

```text
Decimal("12345678901234567890.1200")
  -> 1.2345678901234567e+19
```

datetime/date 会进入 callback，因此单纯增加 `default=` 只能解决一半问题。

推荐在 `platform-common` 提供基于 orjson 的标准 JSON encoder，并在 Nameko config 中覆盖 serializer name `json`，wire content type 仍为标准 `application/json`：

```python
from decimal import Decimal

import orjson


def encode_value(value):
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


def encode(value):
    return orjson.dumps(value, default=encode_value)


def decode(value):
    return orjson.loads(value)
```

orjson 原生将 date/datetime 编码为 ISO/RFC 3339 string；Decimal 不属于其原生类型，因此稳定进入 `default` 并通过 `str()` 保留 `Decimal("12.30")` 的 scale。Phase A 为兼容现有行为暂时允许 naive datetime；最终 contract 应要求 timezone-aware datetime，并明确统一 UTC 还是保留原 offset。金额字段仍应在 schema 中明确 quantize/scale 规则。

配置形态：

```yaml
serializer: xjson  # 迁移初期保持不变

SERIALIZERS:
  json:
    encoder: platform_common.serializers.json.encode
    decoder: platform_common.serializers.json.decode
    content_type: application/json
  xjson:
    encoder: platform_common.xjson.encode
    decoder: platform_common.xjson.decode
    content_type: application/xjson

ACCEPT:
  - json
  - xjson
```

contracts service 应删除同 MIME type 的 `ujson` registration，避免 `application/json -> ujson` 覆盖。若坚持保留 ujson encoder，只能在调用前递归把 Decimal/date/datetime 预转换成 string；这会多一次完整对象树遍历和临时对象分配。本地 typed payload 基准中：

| Payload | stdlib + default | orjson + default | normalize + ujson |
|---:|---:|---:|---:|
| 111 KB | 1.90 ms | 0.19 ms | 2.70 ms |
| 1.12 MB | 17.8 ms | 1.93 ms | 26.4 ms |
| 4.51 MB | 71.6 ms | 8.08 ms | 108.4 ms |

Kombu 5.3.7 可直接发布 `orjson.dumps()` 返回的 bytes，因此不需要 `.decode("utf-8")` 的额外完整复制。长期仍应让 output schema/DTO 自己产生 JSON-native values；encoder 的兼容转换用于迁移和防漏，不代替字段契约。

## 6. 迁移设计

### Stage 0：冻结并观测 legacy 协议

1. xjson 不再增加新 tag/type。
2. 对线上使用的 `platform-common` 4.0.11/12/14/20 wheels 运行 golden-vector suite，覆盖 dictionary/list 中的 tag、tag-like 普通字符串、timezone-aware/naive datetime、Decimal scale、set/empty set；记录 wheel hash 与行为。
3. 在所有 Python 服务注册 `platform-common` 标准 JSON encoder；contracts 删除 ujson 对 `application/json` 的重复注册。迁移初期各服务默认 serializer 仍保持 xjson。
4. Kinopio 增加显式 per-call/per-target content type，优先级为 per-call > target override > client default；client default 暂时保持 xjson。
5. Kinopio parser 改为 content-type aware：
   - `application/xjson`：legacy decode；
   - `application/json`：plain `JSON.parse`；
   - 缺少 content type：迁移期走 legacy fallback 并计数，最终改为拒绝；
   - 未知 content type：typed serialization error。
6. `content_type` 不再从 `workerCtx` 隐式读取；旧字段只保留 deprecated bridge。
7. 增加低基数指标：

```text
kinopio.rpc.wire_messages{direction, content_type, service}
kinopio.rpc.payload_bytes{direction, content_type, bucket}
kinopio.rpc.decode_duration{content_type, size_bucket}
kinopio.rpc.legacy_tags{type, service}
kinopio.rpc.json_marker_violation{type, service}
```

不记录 tag value、payload、result 或 correlation ID。

8. 对 legacy xjson 可先做安全 fast path：raw body 不包含 `"!!datetime `、`"!!date ` 或 `"!!decimal ` 时直接 `JSON.parse`，避免无 tag payload 的全树 reviver。它只是过渡优化，不改变退出目标。
9. 对标准 JSON 先用 raw substring 做 Kombu marker candidate 检测；只有同时出现 `"__type__"` 和 `"__value__"` 时才遍历已解析对象并验证完整 envelope，避免为正常 JSON 永久增加第二次全树扫描。

### Stage 1：建立 JSON-native contract gate

1. 为 Tier 0 和高流量 RPC 建 integration contract test：用 `application/json` 发起真实 Nameko RPC，并拒绝 response 中任何 Kombu typed envelope。
2. 服务 response/event 在发布前执行测试期 `assertJsonNative`；报告 JSON path 和实际 Python type。
3. 先修复明确的 Decimal/date/datetime/set 输出：
   - Marshmallow Decimal output 统一 `as_string=True`；
   - method 直接返回的 Decimal 显式 `str()`；
   - date/datetime 在 output schema 中规范化；
   - set 转成排序 array。
4. Python caller 若依赖 xjson 自动恢复类型，在 caller 的 input schema/DTO mapper 中显式恢复，不允许继续依赖 transport serializer。

静态扫描只能定位直接 constructor；helper、ORM model 和 schema dump 会漏报，所以它只能生成初始名单，不能作为完成标准。

### Stage 2：Kinopio caller-driven canary

发布兼容版 Kinopio，默认仍为 xjson，但允许按 target 选择：

```ts
serialization: {
  defaultContentType: 'application/xjson',
  jsonTargets: [
    'locations.list_countries',
    'properties.get_property',
  ],
}
```

建议顺序：

1. 小 payload、只读、无 Decimal 的 RPC；
2. 高频 read RPC；
3. 大 payload RPC，用 decode duration 验证收益；
4. write RPC；
5. billing/prices 等 Decimal 密集 RPC。

每个 target 保留 xjson rollback switch。由于 Nameko response 按 request content type 反查本地 codec，这个开关可以同时回滚 request/response 的 xjson 或 JSON wire family；不能依赖它保证两端 encoder identity 相同。

### Stage 3：Python caller 与 event producer 迁移

1. 逐 calling service 把 outgoing RPC serializer 切到 json；切换前验证它调用的所有 target 已通过 JSON-native contract gate。
2. EventDispatcher 单独迁移。先验证 event payload，再切 producer；所有 consumer 继续 dual accept。
3. 检查 durable queue、retry queue 和 DLQ 中旧 xjson 消息的最大存活时间；不能只看实时 producer 已停止。
4. cron 的 `json` 和 contracts 的 `ujson` 现状纳入同一 contract suite，不能因当前可运行就假设语义一致。

### Stage 4：默认 JSON，停止 xjson write

满足以下条件后：

- 所有 Tier 0/1 contract tests 通过；
- xjson write traffic 为 0；
- Kombu marker violation 为 0；
- no-tag/typed-tag telemetry 与预期一致；
- queue backlog、retry 和 DLQ 中无存活 legacy message；
- 至少经历两个正常发布周期。

执行：

1. Kinopio 默认改为 `application/json`；
2. 所有 Nameko caller/event producer 默认改为 json；
3. xjson 保留 read-only compatibility 一个发布周期。

### Stage 5：删除 legacy support

1. 从 21 个 deploy config 的 `ACCEPT` 和 `SERIALIZERS` 删除 xjson；
2. 删除 `platform_common.xjson` 和相关 tests/dependency；
3. Kinopio major version 删除 `parseXJson`、legacy fast path 和 `workerCtx.content_type` bridge；
4. 删除 migration metrics，只保留 content type、payload size 和 decode duration 的常规指标；
5. 将 JSON-native contract test 设为 CI 必过项，防止 Decimal/datetime magic 回归。

## 7. 回滚策略

迁移阶段的回滚单位是 caller target，而不是整个 RabbitMQ cluster：

- Kinopio target 出现 marker violation/shape regression：该 target 立即切回 xjson；
- Python calling service 出现类型错误：恢复该 caller 的 outgoing serializer；
- event consumer 出现 decode error：停止该 producer 的 json rollout，consumer 继续 dual accept；
- 不删除 xjson registration，直到 live traffic 和积压消息都归零。

回滚只恢复 wire format，不恢复已经发布的新 DTO 语义。为使两种 serializer 共存，迁移后的 DTO 本身必须使用明确 string/array 表达；这也是先做 JSON-native contract、再切 content type 的原因。

## 8. 推荐实施顺序

1. 先完成 Phase A；它的性能成本远小于现有 xjson parse 和 camelize 成本。
2. Phase A observer 同时加入 content type、payload bytes、decode duration 和 legacy tag 指标。
3. Kinopio 增加 content-type aware parser 与 no-tag fast path，但默认保持 xjson。
4. 建立 JSON-native contract suite，先修 `billing.cancel_payment_items` 等明确 Decimal 输出。
5. 按 target canary 标准 JSON；从小型只读接口开始，再处理大 payload 和金额域。
6. Gateway 稳定后迁移 Python caller 和 event producer。
7. traffic + backlog 连续归零两个发布周期后，删除 xjson。

## 9. ADR-003：以显式 JSON-native DTO 取代 xjson

### Status

Proposed

### Context

xjson 通过字符串 tag 在 Python 端隐式保留类型，但 Node 端只做不完整的前缀删除。协议具有跨语言语义不一致、合法字符串碰撞、set 私有表示、全树 decode 开销和部署耦合。

### Decision

- 最终 transport 使用 `application/json`；
- RPC/event DTO 只包含 JSON-native value；
- datetime/date/Decimal/set 在 schema/DTO boundary 显式映射；
- 不在 Kinopio 中支持 Python serializer-specific typed envelope；
- 采用 dual-read、caller-driven single-target write、traffic/backlog 归零后删除的迁移策略。

### Consequences

正面：

- Python、Node 和其他语言看到相同 wire shape；
- 移除 reviver 后降低大 payload CPU；
- 类型错误在 contract test/DTO boundary 暴露，而不是由 serializer 隐式修复；
- service/method 级回滚，不要求停机切换全集群。

负面：

- Python caller 不能再依赖 transport 自动恢复 Decimal/date；
- 需要逐步修复 output schema 和 caller input mapping；
- 迁移期需同时维护 json/xjson read path 和专项 telemetry。

拒绝的替代方案：

- 直接全局切 `serializer: json`：Kombu marker object 会破坏 Gateway shape；
- Kinopio 实现 Kombu marker decoder：继续耦合 Python 私有实现；
- 优化并永久保留 xjson：只能降低 CPU，不能解决协议语义问题；
- Decimal 转 JSON number：金额精度和 scale 不可接受。
