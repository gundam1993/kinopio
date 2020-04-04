import * as uuid from 'uuid/v4';
import * as amqp from 'amqplib';

interface EntrypointsHooks {
  processResponse?: (response: any) => any;
  onResponse?: (response: any) => void;
  onRequest?: (
    serviceName: string,
    functionName: string,
    rpcPayload: object,
  ) => void;
}

export enum EventHandlerType {
  SERVICE_POOL,
  SINGLETON,
  BROADCAST,
}

export class RpcError extends Error {
  code: string;
  remoteArgs?: string[];
  remoteName?: string;
  remoteFullName?: string;

  constructor(
    message: string,
    remoteArgs?: string[],
    remoteName?: string,
    remoteFullName?: string,
  ) {
    super(message);
    this.code = 'RPC_REMOTE_ERROR';
    this.name = this.constructor.name;
    this.remoteArgs = remoteArgs;
    this.remoteName = remoteName;
    this.remoteFullName = remoteFullName;

    // Set the prototype explicitly.
    Object.setPrototypeOf(this, RpcError.prototype);
  }
}

class EventHandlerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function parseXJson(_: any, value: any) {
  if (typeof value === 'string') {
    const stringableMatches = value.match(/^\!\!(datetime|date|decimal) (.*)/);
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

export type RpcMethod<T = any> = (payload?: RpcPayload) => Promise<T>;

export interface ServiceBase {
  [key: string]: RpcMethod | any;
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
    rpcPayload: object,
  ) => void;
  onResponse?: (response: any) => void;
  processResponse?: (response: any) => any;
  queuePrefix?: string;
  logger?: any;
  requestLogger?: any;
  responseLogger?: any;
  onConnect?: (connection: amqp.Connection, channel: amqp.Channel) => any;
  reconnectInterval?: number;
  reconnectMaxAttemptes?: number;
}

export interface EventHandlerArgs {
  sourceService: string;
  eventType: string;
  handlerType: EventHandlerType;
  handlerName: string | symbol;
  handlerFunction: (msg: any) => any;
  reliableDelivery: boolean;
  requeueOnError: boolean;
}

export class Kinopio {
  private serviceName: string = 'kinopio';
  private mqOptions: amqp.Options.Connect;
  private connection: amqp.Connection | undefined;
  private channel: amqp.Channel | undefined;
  private eventChannels: amqp.Channel[];
  private entrypointHooks: EntrypointsHooks;
  private queuePrefix: string;
  private rpcResolvers: any = {};
  private replyToId: string;
  private logger: (message?: any, ...optionalParams: any[]) => any;
  private requestLogger: (
    msg: string,
    correlationId: string,
    routingKey: string,
    rpcPayload?: any,
  ) => any;
  private responseLogger: (
    msg: string,
    correlationId: string,
    routingKey: string,
    rpcPayload?: any,
  ) => any;
  private reconnectLock: boolean = false;
  private userCallbackOnConnect: any;
  private reconnectInterval: number;
  private reconnectMaxAttemptes: number;
  private numAttempts: number = 0;
  private eventChannelsArgs: EventHandlerArgs[];

  constructor(serviceName: string = 'kinopio', config: KinopioConfig) {
    if (!config) throw new Error('Kinopio requires options.');
    this.serviceName = serviceName;
    const {
      hostname,
      port,
      vhost,
      username,
      password,
      onRequest,
      onResponse,
      processResponse,
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
    this.queuePrefix = queuePrefix || 'rpc.replay';
    this.replyToId = uuid();
    this.logger = logger;
    this.requestLogger = requestLogger || this.logger;
    this.responseLogger = responseLogger || this.logger;
    this.userCallbackOnConnect =
      onConnect ||
      (() => {
        return;
      });
    this.reconnectInterval = reconnectInterval || 2000;
    this.reconnectMaxAttemptes = reconnectMaxAttemptes || 10;
    this.eventChannels = [];
    this.eventChannelsArgs = [];
  }

  public async connect(): Promise<RpcContext> {
    await this.connectMq();
    if (this.eventChannelsArgs.length) {
      this.eventChannelsArgs.forEach((element) => {
        this.createEventHandler(element);
      });
      this.eventChannelsArgs = [];
    }
  }

  public async close(): Promise<void> {
    this.logger('disconnectiong from smqp server...');
    await this.channel?.close();
    this.channel = undefined;
    await this.connection?.close();
    this.connection = undefined;
    this.logger('amqp server disconnected');
  }

  public buildRpcProxy = (workerCtx = {}): RpcContext => {
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
                return (payload: any) =>
                  this.callRpc(
                    serviceTarget.serviceName.toString(),
                    functionName.toString(),
                    payload,
                    target.workerCtx,
                  );
              },
            },
          );
        },
      },
    );
  };

  public rpcEventHandler = (
    sourceService: string,
    eventType: string,
    handlerType: EventHandlerType = EventHandlerType.SERVICE_POOL,
    reliableDelivery: boolean = true,
    requeueOnError: boolean = false,
  ): MethodDecorator => {
    return (
      target,
      propertyKey: string | symbol,
      descriptor: PropertyDescriptor,
    ): void => {
      const originalFunction = descriptor.value;
      this.createEventHandler({
        sourceService,
        eventType,
        handlerType,
        reliableDelivery,
        requeueOnError,
        handlerName: propertyKey,
        handlerFunction: originalFunction.bind(target),
      });
    };
  };

  public createEventHandler = async (eventHandlerInfo: EventHandlerArgs) => {
    const {
      sourceService,
      eventType,
      handlerType,
      handlerName,
      handlerFunction,
      reliableDelivery,
      requeueOnError,
    } = eventHandlerInfo;
    let exclusive = false;
    const serviceName = this.serviceName;
    let queueName: string;
    const handlerNameString = handlerName.toString();
    if (handlerType === EventHandlerType.SERVICE_POOL) {
      queueName = `evt-${sourceService}-${eventType}--${serviceName}.${handlerNameString}`;
    } else if (handlerType === EventHandlerType.SINGLETON) {
      queueName = `evt-${sourceService}-${eventType}`;
    } else {
      if (reliableDelivery) {
        throw new EventHandlerConfigurationError(
          `You are using the default broadcast identifier 
          which is not compatible with reliable delivery.`,
        );
      }
      queueName = `evt-${sourceService}-${eventType}--${serviceName}.${handlerNameString}-${uuid()}`;
    }
    const exchangeName = `${sourceService}.events`;
    /**
     * queues for handlers without reliable delivery should be marked as
     * autoDelete so they're removed when the consumer disconnects
     */
    const autoDelete = !requeueOnError;
    exclusive = handlerType === EventHandlerType.BROADCAST;
    if (reliableDelivery) {
      exclusive = false;
    }
    if (!this.connection) {
      this.eventChannelsArgs.push(eventHandlerInfo);
      return;
    }
    const eventChannel = await this.connection.createChannel();
    eventChannel.on('close', () => {
      this.logger(`event channel ${queueName} close`);
      this.reestablishConnection();
    });
    eventChannel.on('error', () => {
      this.logger(`event channel ${queueName} error`);
      this.reestablishConnection();
    });
    this.eventChannels.push(eventChannel);
    const eventExchange = await eventChannel?.assertExchange(
      exchangeName,
      'topic',
      {
        durable: true,
        autoDelete: true,
      },
    );
    const eventQueue = await eventChannel.assertQueue(queueName, {
      autoDelete,
      exclusive,
      durable: true,
    });
    await eventChannel.bindQueue(
      eventQueue.queue,
      eventExchange.exchange,
      eventType,
    );
    await eventChannel.consume(
      eventQueue.queue,
      (message) => {
        const messageContent = this.parseMessage(message);
        handlerFunction(messageContent);
      },
      {
        noAck: true,
      },
    );
  };

  protected callRpc = async (
    serviceName: string,
    functionName: string,
    payload: RpcPayload = {},
    workerCtx: any = {},
  ) => {
    const routingKey = `${serviceName}.${functionName}`;
    const correlationId = uuid();
    return new Promise((resolve, reject) => {
      if (!this.channel) {
        reject('Channel not ready');
      }
      this.rpcResolvers[correlationId] = { resolve, reject };
      const { args = [], kwargs = {} } = payload;
      const rpcPayload = { args, kwargs };

      this.entrypointHooks.onRequest &&
        this.entrypointHooks.onRequest(serviceName, functionName, rpcPayload);

      this.requestLogger(
        '%s: %s() payload: %o',
        correlationId,
        routingKey,
        rpcPayload,
      );
      this.logger('workerCtx: %o', workerCtx);

      this.channel!.publish(
        'nameko-rpc',
        routingKey,
        new Buffer(JSON.stringify(rpcPayload)),
        {
          correlationId,
          replyTo: this.replyToId,
          headers: workerCtx,
          contentEncoding: 'utf-8',
          contentType: workerCtx.content_type || 'application/xjson',
          deliveryMode: 2,
          priority: 0,
        },
      );
    });
  };

  protected consumeQueue = (message: any) => {
    const { correlationId } = message.properties;

    if (correlationId in this.rpcResolvers) {
      const messageContent = this.parseMessage(message);

      const resolver = this.rpcResolvers[correlationId];
      this.rpcResolvers[correlationId] = undefined;

      this.responseLogger('%s: payload: %o', correlationId, messageContent);

      if (messageContent.error) {
        resolver.reject(
          new RpcError(
            messageContent.error.value,
            messageContent.error.exc_args,
            messageContent.error.exc_type,
            messageContent.error.exc_path,
          ),
        );
      } else {
        if (this.entrypointHooks.processResponse) {
          messageContent.result = this.entrypointHooks.processResponse(
            messageContent.result,
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
      this.reestablishConnection();
    });

    this.connection.on('error', () => {
      this.logger('connection error');
      this.reestablishConnection();
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
      `connected to amqp server: amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`,
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

  protected parseMessage(message: any) {
    const rawMessageContent = message.content.toString();
    const messageContent = JSON.parse(rawMessageContent, parseXJson);
    return messageContent;
  }

  protected reestablishConnection() {
    if (this.reconnectLock) {
      return;
    }
    this.reconnectLock = true;
    this.logger(
      `connection closed, try to connect in ${
        this.reconnectInterval / 1000
      } seconds`,
    );
    setTimeout(this.reconnect, this.reconnectInterval);
  }

  protected reconnect = async () => {
    this.logger(
      `trying to reconnect to amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`,
    );
    this.numAttempts += 1;
    const timeout =
      this.reconnectInterval + this.numAttempts * this.reconnectInterval;
    try {
      await this.connectMq();
      this.reconnectLock = false;
    } catch (error) {
      if (this.numAttempts === this.reconnectMaxAttemptes) {
        this.logger(
          `failed to reconnect after ${this.reconnectMaxAttemptes} tries`,
        );
        throw new Error(
          `AMQP disconnected after ${this.reconnectMaxAttemptes} attempts`,
        );
      }
      this.logger(
        `could not connect, trying again in ${timeout / 1000} seconds`,
      );
      setTimeout(this.reconnect, this.reconnectInterval);
    }
  };
}
