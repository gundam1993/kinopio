# Kinopio

*A node client of nameko*

## Installation

Install the `Kinopio` using:

    yarn add kinopio

## Phase A RPC controls

Existing calls remain compatible. Deadline, overload protection and standard
JSON rollout are opt-in:

```ts
const kinopio = new Kinopio('gateway', {
  hostname: 'rabbitmq',
  rpc: {
    defaultTimeoutMs: 30_000,
    healthcheckTimeoutMs: 5_000,
    maxInflight: 2_000,
  },
  serialization: {
    // Keep legacy behavior during migration.
    defaultContentType: 'application/xjson',
    contentTypeByTarget: {
      'locations.list_countries': 'application/json',
    },
  },
});
```

Per-call options take precedence over the target and client defaults:

```ts
await rpc.locations.list_countries(
  {},
  {
    contentType: 'application/json',
    timeoutMs: 10_000,
    signal: requestAbortSignal,
  },
);
```

Use `getSnapshot()` and a synchronous, non-throwing `observer` adapter to
export connection, in-flight, duration, content-type and payload-size metrics.
Kinopio isolates observer exceptions from RPC outcomes. It never sends payload,
result or correlation IDs to the observer.

## Connection lifecycle

A `Kinopio` instance has a one-shot lifecycle. Unexpected AMQP connection,
channel or reply-consumer failures trigger automatic reconnect on the same
instance. Calling `close()` is terminal: it stops reconnecting, rejects pending
RPCs and releases AMQP resources. Create a new instance instead of calling
`connect()` again after `close()`.

See [Phase A / Phase B Todo](./docs/phase-a-b-todo.md) for rollout constraints
and the remaining connection/backpressure work.
