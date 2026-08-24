import {
  Kinopio,
  KinopioConfig,
  KinopioObserver,
  RpcCallOptions,
  RpcCancelledError,
  RpcConnectionLostError,
  RpcContentTypeMismatchError,
  RpcOverloadedError,
  RpcPayload,
  RpcPublishError,
  RpcSerializationError,
  RpcTimeoutError,
} from '..';

class TestKinopio extends Kinopio {
  public setChannel(channel: any): void {
    (this as any).channel = channel;
  }

  public invoke(
    service: string,
    method: string,
    payload: RpcPayload = {},
    workerCtx: any = {},
    options: RpcCallOptions = {},
  ): Promise<any> {
    return this.callRpc(service, method, payload, workerCtx, options);
  }

  public deliver(message: any): void {
    this.consumeQueue(message);
  }

  public failTransport(): void {
    (this as any).handleTransportFailure('test disconnect');
  }
}

function makeClient(config: Partial<KinopioConfig> = {}) {
  const channel = {
    close: jest.fn(() => Promise.resolve()),
    publish: jest.fn(() => true),
  };
  const client = new TestKinopio('gateway', {
    logger: () => undefined,
    requestLogger: () => undefined,
    responseLogger: () => undefined,
    ...config,
  });
  client.setChannel(channel);
  return { channel, client };
}

function lastRequest(channel: any) {
  const publishCall =
    channel.publish.mock.calls[channel.publish.mock.calls.length - 1];
  return {
    body: publishCall[2] as Buffer,
    properties: publishCall[3],
  };
}

function deliverResult(
  client: TestKinopio,
  channel: any,
  result: any,
  contentType?: string,
) {
  const request = lastRequest(channel);
  const properties: any = {
    correlationId: request.properties.correlationId,
  };
  if (contentType !== undefined) {
    properties.contentType = contentType;
  }
  client.deliver({
    content: Buffer.from(JSON.stringify({ result, error: null })),
    properties,
  });
}

describe('Phase A RPC lifecycle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('cleans up a pending call after a successful response', async () => {
    const { channel, client } = makeClient();
    const call = client.invoke('locations', 'ping');

    expect(client.getSnapshot().pendingRpc).toBe(1);
    deliverResult(client, channel, 'pong', 'application/xjson');

    await expect(call).resolves.toBe('pong');
    expect(client.getSnapshot().pendingRpc).toBe(0);
  });

  test('times out and removes the pending call', async () => {
    jest.useFakeTimers();
    const { client } = makeClient({ rpc: { defaultTimeoutMs: 25 } });
    const call = client.invoke('locations', 'slow');

    jest.advanceTimersByTime(25);

    await expect(call).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(client.getSnapshot().pendingRpc).toBe(0);
  });

  test('enforces maxInflight without disturbing existing calls', async () => {
    const { channel, client } = makeClient({ rpc: { maxInflight: 1 } });
    const first = client.invoke('locations', 'first');

    await expect(client.invoke('locations', 'second')).rejects.toBeInstanceOf(
      RpcOverloadedError,
    );
    expect(client.getSnapshot().pendingRpc).toBe(1);

    deliverResult(client, channel, 'done', 'application/xjson');
    await expect(first).resolves.toBe('done');
  });

  test('settles and cleans up when publish throws', async () => {
    const { channel, client } = makeClient();
    channel.publish.mockImplementation(() => {
      throw new Error('publish failed');
    });

    await expect(client.invoke('locations', 'ping')).rejects.toBeInstanceOf(
      RpcPublishError,
    );
    expect(client.getSnapshot().pendingRpc).toBe(0);
  });

  test('connection loss rejects all current pending calls', async () => {
    const { client } = makeClient();
    const first = client.invoke('locations', 'first');
    const second = client.invoke('locations', 'second');

    client.failTransport();

    await expect(first).rejects.toBeInstanceOf(RpcConnectionLostError);
    await expect(second).rejects.toBeInstanceOf(RpcConnectionLostError);
    expect(client.getSnapshot().pendingRpc).toBe(0);
    await client.close();
  });

  test('AbortSignal cancels and removes a pending call', async () => {
    const { client } = makeClient();
    const controller = new AbortController();
    const call = client.invoke(
      'locations',
      'cancelled',
      {},
      {},
      { signal: controller.signal },
    );

    controller.abort();

    await expect(call).rejects.toBeInstanceOf(RpcCancelledError);
    expect(client.getSnapshot().pendingRpc).toBe(0);
  });

  test('late replies after a timeout are counted without settling twice', async () => {
    jest.useFakeTimers();
    const { channel, client } = makeClient({ rpc: { defaultTimeoutMs: 25 } });
    const call = client.invoke('locations', 'slow');

    jest.advanceTimersByTime(25);
    await expect(call).rejects.toBeInstanceOf(RpcTimeoutError);
    deliverResult(client, channel, 'late', 'application/xjson');

    expect(client.getSnapshot()).toMatchObject({
      pendingRpc: 0,
      lateReplies: 1,
    });
  });

  test('close rejects all pending calls', async () => {
    const { client } = makeClient();
    const call = client.invoke('locations', 'ping');

    await client.close();

    await expect(call).rejects.toMatchObject({ code: 'RPC_CLOSED' });
    expect(client.getSnapshot()).toMatchObject({
      state: 'closed',
      pendingRpc: 0,
    });
  });
});

describe('Phase A content type negotiation', () => {
  test('uses per-call, per-target, deprecated worker context and default priority', async () => {
    const { channel, client } = makeClient({
      serialization: {
        defaultContentType: 'application/xjson',
        contentTypeByTarget: {
          'locations.target': 'application/json',
        },
      },
    });

    const targetCall = client.invoke(
      'locations',
      'target',
      {},
      { content_type: 'application/xjson' },
    );
    expect(lastRequest(channel).properties.contentType).toBe(
      'application/json',
    );
    expect(
      lastRequest(channel).properties.headers.content_type,
    ).toBeUndefined();
    deliverResult(client, channel, 'target', 'application/json');
    await targetCall;

    const perCall = client.invoke(
      'locations',
      'target',
      {},
      {},
      { contentType: 'application/xjson' },
    );
    expect(lastRequest(channel).properties.contentType).toBe(
      'application/xjson',
    );
    deliverResult(client, channel, 'per-call', 'application/xjson');
    await perCall;

    const bridge = client.invoke(
      'locations',
      'legacy',
      {},
      { content_type: 'application/json' },
    );
    expect(lastRequest(channel).properties.contentType).toBe(
      'application/json',
    );
    deliverResult(client, channel, 'bridge', 'application/json');
    await bridge;

    const defaultCall = client.invoke('locations', 'default');
    expect(lastRequest(channel).properties.contentType).toBe(
      'application/xjson',
    );
    deliverResult(client, channel, 'default', 'application/xjson');
    await defaultCall;
  });

  test('plain JSON preserves legitimate strings that resemble xjson tags', async () => {
    const { channel, client } = makeClient({
      serialization: { defaultContentType: 'application/json' },
    });
    const call = client.invoke('locations', 'tag_like_string');

    deliverResult(
      client,
      channel,
      '!!date this is business text',
      'application/json',
    );

    await expect(call).resolves.toBe('!!date this is business text');
  });

  test('legacy xjson still removes supported tags', async () => {
    const { channel, client } = makeClient();
    const call = client.invoke('locations', 'legacy');

    deliverResult(
      client,
      channel,
      { price: '!!decimal 12.30', date: '!!date 2026-08-23' },
      'application/xjson',
    );

    await expect(call).resolves.toEqual({
      price: '12.30',
      date: '2026-08-23',
    });
  });

  test('missing content type uses the migration-period xjson fallback', async () => {
    const finishes: any[] = [];
    const observer: KinopioObserver = {
      onRpcFinish: (event) => finishes.push(event),
    };
    const { channel, client } = makeClient({ observer });
    const call = client.invoke('locations', 'legacy');

    deliverResult(client, channel, '!!date 2026-08-23');

    await expect(call).resolves.toBe('2026-08-23');
    expect(finishes[0].responseContentTypeStatus).toBe('missing');
  });

  test('rejects a supported but mismatched response content type', async () => {
    const finishes: any[] = [];
    const { channel, client } = makeClient({
      serialization: { defaultContentType: 'application/json' },
      observer: { onRpcFinish: (event) => finishes.push(event) },
    });
    const call = client.invoke('locations', 'mismatch');

    deliverResult(client, channel, 'value', 'application/xjson');

    await expect(call).rejects.toBeInstanceOf(RpcContentTypeMismatchError);
    expect(client.getSnapshot().pendingRpc).toBe(0);
    expect(finishes[0]).toMatchObject({
      responseContentType: 'application/xjson',
      responseContentTypeStatus: 'mismatch',
    });
  });

  test('rejects unknown response content types', async () => {
    const finishes: any[] = [];
    const { channel, client } = makeClient({
      observer: { onRpcFinish: (event) => finishes.push(event) },
    });
    const call = client.invoke('locations', 'unknown');

    deliverResult(client, channel, 'value', 'application/xml');

    await expect(call).rejects.toBeInstanceOf(RpcSerializationError);
    expect(finishes[0]).toMatchObject({
      responseContentType: 'application/xml',
      responseContentTypeStatus: 'unknown',
    });
  });

  test('rejects Kombu typed envelopes on the standard JSON path', async () => {
    const { channel, client } = makeClient({
      serialization: { defaultContentType: 'application/json' },
    });
    const call = client.invoke('locations', 'marker');

    deliverResult(
      client,
      channel,
      { amount: { __type__: 'decimal', __value__: '12.30' } },
      'application/json',
    );

    await expect(call).rejects.toBeInstanceOf(RpcSerializationError);
  });
});

describe('Phase A observer', () => {
  test('isolates observer exceptions from the RPC result', async () => {
    const observer: KinopioObserver = {
      onRpcStart: () => {
        throw new Error('observer failed');
      },
      onRpcFinish: () => {
        throw new Error('observer failed');
      },
    };
    const { channel, client } = makeClient({ observer });
    const call = client.invoke('locations', 'ping');

    deliverResult(client, channel, 'pong', 'application/xjson');

    await expect(call).resolves.toBe('pong');
    expect(client.getSnapshot().observerErrors).toBe(2);
  });
});
