import { ServiceBase, RpcMethod, RpcContext, RpcError, Kinopio } from '..';
import { camelizeKeys } from 'humps';

import { Resource } from '@opentelemetry/resources';
// import { SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const provider = new NodeTracerProvider({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'kinopio-test',
  }),
});
// uncomment below to see the trace in the console
// provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

import { trace, context } from '@opentelemetry/api'
const tracer = trace.getTracerProvider().getTracer('test-service')

interface TestService extends ServiceBase {
  ping: RpcMethod;
  repeat: RpcMethod;
  get_some_data: RpcMethod;
  get_some_xjson_data: RpcMethod;
  raise_noraml_exception: RpcMethod;
  raise_custom_exception: RpcMethod;
  return_worker_ctx: RpcMethod;
}

interface TestContext {
  test_service: TestService;
}

const hostname = process.env.RABBIT_SERVER;
const port = parseInt(process.env.RABBIT_PORT as string, 10);
const vhost = process.env.RABBIT_VHOST;
const username = process.env.RABBIT_USER;
const password = process.env.RABBIT_PASS;
const namekoWorkerCtx = {
  'nameko.authorization': 'testAuthorization',
  'nameko.language': 'en-us',
  'nameko.locale': 'en-us',
};

describe('rpc', () => {
  const kinopio = new Kinopio('kinopio', {
    hostname,
    port,
    vhost,
    username,
    password,
    logger: () => {},
    requestLogger: () => {},
    responseLogger: () => {},
  });

  let rpc: RpcContext<TestContext>;
  beforeAll(async () => {
    await kinopio.connect();
  });
  afterAll(() => kinopio.close());
  beforeEach(async () => {
    rpc = await kinopio.buildRpcProxy(Object.assign({}, namekoWorkerCtx));
  });

  test('can make a basic rpc call', async () => {
    await expect(rpc.test_service.ping()).resolves.toBe('pong');
  });

  test('passes default args and kwargs', async () => {
    const args = [1, 2, 3];
    const kwargs = { foo: 'bar' };
    await expect(rpc.test_service.repeat({ args, kwargs })).resolves.toEqual({
      args,
      kwargs,
    });
  });

  test('can get serialised data', async () => {
    await expect(rpc.test_service.get_some_data()).resolves.toEqual({
      int: 1,
      float: 0.01,
      string: 'foo',
      boolean: true,
      array: [1, 2, 3],
      object: { key: 'value' },
    });
  });

  test('can get serialised xjson data', async () => {
    const result = await rpc.test_service.get_some_xjson_data();
    console.log('result: ', result);
    expect(result).toEqual({
      datetime: '2018-01-01T01:01:01',
      date: '2018-05-29',
      decimal: '3.1415',
      int: 1,
      float: 0.01,
      string: 'foo',
      boolean: true,
      array: [1, 2, 3],
      object: { key: 'value' },
    });
  });

  test('rejects a normal exception', async () => {
    await expect(
      rpc.test_service.raise_noraml_exception(),
    ).rejects.toMatchObject(
      new RpcError(
        'normal exception',
        ['normal exception'],
        'Exception',
        'builtins.Exception',
      ),
    );
  });

    test('rejects a custom exception', async () => {
      await expect(
        rpc.test_service.raise_custom_exception(),
      ).rejects.toMatchObject(
        new RpcError(
          'custom exception',
          ['custom exception'],
          'CustomException',
          'service.CustomException',
        ),
      );
    });

    test('passes context', async () => {
      const res = await rpc.test_service.return_worker_ctx();
      expect(res.authorization).toEqual('testAuthorization');
      expect(res.language).toEqual('en-us');
      expect(res.locale).toEqual('en-us');
    });

    test('return workerCtx', async () => {
      expect(rpc.workerCtx['nameko.authorization']).toEqual('testAuthorization');
      expect(rpc.workerCtx['nameko.language']).toEqual('en-us');
      expect(rpc.workerCtx['nameko.locale']).toEqual('en-us');
    });

    test('opentelemetry context not propogates when opentelemetry is disabled', async () => {
      const span = tracer.startSpan('otel-context-propogates');
      const ctx = trace.setSpan(context.active(), span);
      context.with(ctx, async () => {
        process.env.OPENTELEMETRY_INSTRUMENT = 'false';
        const res = await rpc.test_service.return_worker_ctx();
        expect(res.traceparent).toBeUndefined();
      });
      span.end();
    });

    test('opentelemetry context propogates correctly', async () => {
      const span = tracer.startSpan('otel-context-propogates');
      const ctx = trace.setSpan(context.active(), span);
      context.with(ctx, async () => {
        process.env.OPENTELEMETRY_INSTRUMENT = 'true'
        const res = await rpc.test_service.return_worker_ctx();
        expect(res.traceparent).not.toBeUndefined();
      });
      span.end();
    });

    test('opentelemetry no active context propogates', async () => {
      process.env.OPENTELEMETRY_INSTRUMENT = 'true'
      const res = await rpc.test_service.return_worker_ctx();
      expect(res.traceparent).toBeUndefined();
    });
  });

  describe('hooks', () => {
    const onRequest = jest.fn();
    const onResponse = jest.fn();
    const processResponse = jest.fn((result) => camelizeKeys(result));

    const kinopio = new Kinopio('kinopio', {
      hostname,
      port,
      vhost,
      username,
      password,
      onRequest,
      onResponse,
      processResponse,
      logger: () => {},
      requestLogger: () => {},
      responseLogger: () => {},
    });
    let rpc: RpcContext<TestContext>;
    beforeAll(async () => {
      await kinopio.connect();
      rpc = await kinopio.buildRpcProxy(namekoWorkerCtx);
    });
    afterAll(() => kinopio.close());

    test('calls onResquest', async () => {
      await rpc.test_service.ping();

      expect(onRequest).toHaveBeenCalledWith('test_service', 'ping', {
        args: [],
        kwargs: {},
      });
    });

    test('call onResquest with args', async () => {
      await rpc.test_service.repeat({ args: [1], kwargs: { foo: 'bar' } });

      expect(onRequest).toHaveBeenCalledWith('test_service', 'repeat', {
        args: [1],
        kwargs: { foo: 'bar' },
      });
    });

    test('call onResponse', async () => {
      await rpc.test_service.ping();
      expect(onResponse).toHaveBeenCalledWith('pong');
    });

    test('processes the responce', async () => {
      const kwargs = { some_key: 'foo' };

      const responce = await rpc.test_service.repeat({
        kwargs,
      });
      expect(processResponse).toHaveBeenCalledWith({ kwargs, args: [] });
      expect(responce).toEqual({ args: [], kwargs: { someKey: 'foo' } });
    });
});
