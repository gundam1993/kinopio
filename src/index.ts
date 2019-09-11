import * as uuid from 'uuid/v4';
import * as amqp from 'amqplib';

interface EntrypointsHooks {
  processResponse?: (response: any) => any;
  onResponse?: (response: any) => void;
  onRequest?: (
    serviceName: string,
    functionName: string,
    rpcPayload: object
  ) => void;
}

export class RpcError extends Error {
  code: string;
  remoteArgs: string[];
  remoteName: string;
  remoteFullName: string;

  constructor(
    message: string,
    remoteArgs?: string[],
    remoteName?: string,
    remoteFullName?: string
  ) {
    super(message);
    this.code = 'RPC_REMOTE_ERROR';
    this.name = this.constructor.name;
    this.remoteArgs = remoteArgs;
    this.remoteName = remoteName;
    this.remoteFullName = remoteFullName;
  }
}

function parseXJson(_, value) {
  if (typeof value === 'string') {
    const stringableMatches = value.match(/^\!\!(datetime|date|deciaml) (.*)/);
    let parsedValue = value;
    if (stringableMatches && stringableMatches.length === 3) {
      parsedValue = stringableMatches[2];
    }
    return parsedValue;
  }
  return value;
}

export interface RpcPayload {
  args?: any[];
  kwargs?: object;
}

export type rpcMethod<T = any> = (payload?: RpcPayload) => Promise<T>;

export interface ServiceBase {
  [key: string]: rpcMethod | any;
}

interface RpcContextBase {
  workerCtx: any;
  [key: string]: ServiceBase | any;
}

export type RpcContext<T = any> = T & RpcContextBase;

export interface KinopioConfig {
  hostname?: string;
  port?: number;
  vhost?: string;
  username?: string;
  password?: string;
  onRequest?: (
    serviceName: string,
    functionName: string,
    rpcPayload: object
  ) => void;
  onResponse?: (response: any) => void;
  processResponse?: (response: any) => any;
  namekoWorkerCtx?: {
    [key: string]: any;
  };
  queuePrefix?: string;
  logger?: any;
  requestLogger?: any;
  responseLogger?: any;
  onConnect?: (connection: amqp.Connection, channel: amqp.Channel) => any;
  reconnectInterval?: number;
  reconnectMaxAttemptes?: number;
}

export class Kinopio {
  private mqOptions: amqp.Options.Connect;
  private connection: amqp.Connection;
  private channel: amqp.Channel;
  private entrypointHooks: EntrypointsHooks;
  private namekoWorkerCtx: {
    [key: string]: any;
  } = {};
  private queuePrefix: string;
  private rpcResolvers: any = {};
  private replyToId: string;
  private logger;
  private requestLogger;
  private responseLogger;
  private reconnectLock: boolean = false;
  private userCallbackOnConnect;
  private reconnectInterval: number;
  private reconnectMaxAttemptes: number;
  private numAttempts: number = 0;

  constructor(config: KinopioConfig) {
    if (!config) throw new Error('Kinopio requires options.');
    const {
      hostname,
      port,
      vhost,
      username,
      password,
      onRequest,
      onResponse,
      processResponse,
      namekoWorkerCtx,
      queuePrefix,
      logger = console.log,
      requestLogger,
      responseLogger,
      onConnect,
      reconnectInterval,
      reconnectMaxAttemptes,
    } = config;

    this.mqOptions = { hostname, port, vhost, username, password };
    this.entrypointHooks = { onRequest, onResponse, processResponse };
    this.namekoWorkerCtx = namekoWorkerCtx || {};
    this.queuePrefix = queuePrefix || 'rpc.replay';
    this.replyToId = uuid();
    this.logger = logger;
    this.requestLogger = requestLogger || this.logger;
    this.responseLogger = responseLogger || this.logger;
    this.userCallbackOnConnect = onConnect || (() => {});
    this.reconnectInterval = reconnectInterval || 2000;
    this.reconnectMaxAttemptes = reconnectMaxAttemptes || 10;
  }

  public async connect(): Promise<RpcContext> {
    await this.connectMq();
    return this.rpcProxy(this.namekoWorkerCtx);
  }

  public async close(): Promise<void> {
    this.logger('disconnectiong from smqp server...');
    await this.channel.close();
    this.channel = undefined;
    await this.connection.close();
    this.connection = undefined;
    this.logger('amqp server disconnected');
  }

  protected rpcProxy = (workerCtx = {}): RpcContext => {
    return new Proxy(
      { workerCtx },
      {
        get: (target, serviceName) => {
          if (serviceName === 'workerCtx') {
            return target.workerCtx;
          }
          return new Proxy(
            { serviceName },
            {
              get: (serviceTarget, functionName) => {
                return (payload) =>
                  this.callRpc(
                    serviceTarget.serviceName.toString(),
                    functionName.toString(),
                    payload,
                    target.workerCtx
                  );
              },
            }
          );
        },
      }
    );
  };

  protected callRpc = async (
    serviceName: string,
    functionName: string,
    payload: RpcPayload = {},
    workerCtx: object = {}
  ) => {
    const routingKey = `${serviceName}.${functionName}`;
    const correlationId = uuid();
    return new Promise((resolve, reject) => {
      this.rpcResolvers[correlationId] = { resolve, reject };
      const { args = [], kwargs = {} } = payload;
      const rpcPayload = { args, kwargs };

      this.entrypointHooks.onRequest &&
        this.entrypointHooks.onRequest(serviceName, functionName, rpcPayload);

      this.requestLogger(
        '%s: %s() payload: %o',
        correlationId,
        routingKey,
        rpcPayload
      );
      this.requestLogger('workerCtx: %o', workerCtx);

      this.channel.publish(
        'nameko-rpc',
        routingKey,
        new Buffer(JSON.stringify(rpcPayload)),
        {
          correlationId,
          replyTo: this.replyToId,
          headers: workerCtx,
          contentEncoding: 'utf-8',
          contentType: 'application/xjson',
          deliveryMode: 2,
          priority: 0,
        }
      );
    });
  };

  protected consumeQueue = (message) => {
    const { correlationId } = message.properties;

    if (correlationId in this.rpcResolvers) {
      const rawMessageContent = message.content.toString();
      const messageContent = JSON.parse(rawMessageContent, parseXJson);

      const resolver = this.rpcResolvers[correlationId];
      this.rpcResolvers[correlationId] = undefined;

      this.responseLogger('%s: payload: %o', correlationId, messageContent);

      if (messageContent.error) {
        resolver.reject(
          new RpcError(
            messageContent.error.value,
            messageContent.error.exc_args,
            messageContent.error.exc_type,
            messageContent.error.exc_path
          )
        );
      } else {
        if (this.entrypointHooks.processResponse) {
          messageContent.result = this.entrypointHooks.processResponse(
            messageContent.result
          );
        }
        this.entrypointHooks.onResponse &&
          this.entrypointHooks.onResponse(messageContent.result);
        resolver.resolve(messageContent.result);
      }
    }
  };

  protected connectMq = async (): Promise<void> => {
    this.connection = await amqp.connect(this.mqOptions);

    this.connection.on('close', () => {
      this.logger('connection close');
      reestablishConnection();
    });

    this.connection.on('error', () => {
      this.logger('connection error');
      reestablishConnection();
    });

    this.channel = await this.connection.createChannel();
    this.channel.on('close', () => {
      this.logger('channel close');
      this.reestablishConnection();
    });
    this.channel.on('error', () => {
      this.logger('channel error');
      this.reestablishConnection();
    });
    this.logger(
      `connected to amqp server: amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`
    );

    const queueName = `${this.queuePrefix}-${this.replyToId}`;
    const queueInfo = await this.channel.assertQueue(queueName, {
      exclusive: true,
      autoDelete: true,
      durable: false,
    });

    await this.channel.bindQueue(queueInfo.queue, 'nameko-rpc', this.replyToId);
    await this.channel.consume(queueInfo.queue, this.consumeQueue, {
      noAck: true,
    });
    this.numAttempts = 0;
    await this.userCallbackOnConnect(this.connection, this.channel);
  };

  protected reestablishConnection() {
    if (this.reconnectLock) {
      return;
    }
    this.reconnectLock = true;
    this.logger(
      `connection closed, try to connect in ${this.reconnectInterval /
        1000} seconds`
    );
    setTimeout(this.reconnect, this.reconnectInterval);
  }

  protected async reconnect() {
    this.logger(
      `trying to reconnect to amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`
    );
    this.numAttempts += 1;
  const timeout = this.reconnectInterval + this.numAttempts * this.reconnectInterval;
  try {
    await this.connectMq();
    this.reconnectLock = false;
  } catch (error) {
    if (this.numAttempts === this.reconnectMaxAttemptes) {
      this.logger(`failed to reconnect after ${this.reconnectMaxAttemptes} tries`);
      throw new Error(`AMQP disconnected after ${this.reconnectMaxAttemptes} attempts`);
    }
    this.logger(`could not connect, trying again in ${timeout / 1000} seconds`);
    setTimeout(this.reconnect, this.reconnectInterval);
  }
  }
}
