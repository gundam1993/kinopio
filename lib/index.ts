import * as uuid from 'uuid/v4';
import * as amqp from 'amqplib';
import { context, propagation } from '@opentelemetry/api';

interface Carrier {
  traceparent?: string;
  tracestate?: string;
}

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

type EventsMapping = {
  [key: string]: string[];
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

export interface RpcEventHandlerMethodInfo {
  sourceService: string;
  eventType: string;
  handlerType: EventHandlerType;
  reliableDelivery: boolean;
  requeueOnError: boolean;
  handlerName: any;
  handlerFunction: any;
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
  target: any;
  sourceService: string;
  eventType: string;
  handlerType: EventHandlerType;
  handlerName: string | symbol;
  handlerFunction: (msg: any, headers: any) => any;
  reliableDelivery: boolean;
  requeueOnError: boolean;
}

export class Kinopio {
  private serviceName: string = 'kinopio';
  private healthcheckRouteKey: string = 'kinopio-healthcheck';
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
        element.handlerFunction = element.handlerFunction.bind(element.target);
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

  public buildRpcProxy = (workerCtx: any = {}): RpcContext => {
    return new Proxy(
      { workerCtx },
      {
        get: (target, serviceName) => {
          if (serviceName === 'workerCtx') {
            return target.workerCtx;
          }
          if (serviceName === 'dispatch') {
            return (eventType: string, eventData: any) => {
              this.dispatchEvent(eventType, eventData, workerCtx);
            };
          }
          return new Proxy(
            { serviceName },
            {
              get: (serviceTarget, functionName) => {
                return (payload: any) =>
                {
                  if (process.env.OPENTELEMETRY_INSTRUMENT === 'true') {
                    const output: Carrier = {};
                    propagation.inject(context.active(), output);
                    const { traceparent, tracestate } = output;
                    if (traceparent) {
                      target.workerCtx['nameko.traceparent'] = traceparent;
                    }
                    if (tracestate) {
                      target.workerCtx['nameko.tracestate'] = tracestate;
                    }
                    this.logger("propagate context", traceparent, tracestate);
                  }

                  return this.callRpc(
                    serviceTarget.serviceName.toString(),
                    functionName.toString(),
                    payload,
                    target.workerCtx,
                  );
                }
              },
            },
          );
        },
      },
    );
  };

  public rpcEventHandlerMethod = (
    sourceService: string,
    eventType: string,
    handlerType: EventHandlerType = EventHandlerType.SERVICE_POOL,
    reliableDelivery: boolean = true,
    requeueOnError: boolean = false,
  ): MethodDecorator => {
    return (target, propertyKey: string | symbol, descriptor): void => {
      const originalFunc = descriptor.value;
      if (!Reflect.has(target, 'rpcEventHandlerMethods')) {
        Reflect.set(target, 'rpcEventHandlerMethods', []);
      }
      if (!Reflect.has(target, 'createEventHandler')) {
        Reflect.set(target, 'createEventHandler', this.createEventHandler);
      }
      const rpcEventHandlerMethods: RpcEventHandlerMethodInfo[] = Reflect.get(
        target,
        'rpcEventHandlerMethods',
      );
      rpcEventHandlerMethods.push({
        sourceService,
        eventType,
        handlerType,
        reliableDelivery,
        requeueOnError,
        handlerName: propertyKey.toString(),
        handlerFunction: originalFunc,
      });
      Reflect.set(target, 'rpcEventHandlerMethods', rpcEventHandlerMethods);
    };
  };

  /**
   * @function
   *    Generate multiple event handlers by event mapping data.
   * @param eventsMapping
   *    i.e.:
   *      const eventsMapping = {
   *        locations: [
   *          "city_updated",
   *          "city_deleted",
   *          "city_translation_updated",
   *          "city_translation_deleted",
   *        ],
   *        properties: [
   *          "property_updated",
   *          "property_deleted"
   *        ]
   *      }
   * @param handlerType 
   * @param reliableDelivery 
   * @param requeueOnError 
   * @returns 
   */

  public rpcEventsHandlerMethod = (
    eventsMapping: EventsMapping,
    handlerType: EventHandlerType = EventHandlerType.SERVICE_POOL,
    reliableDelivery: boolean = true,
    requeueOnError: boolean = false,
  ): MethodDecorator => {
    return (target, propertyKey: string | symbol, descriptor): void => {
      const originalFunc = descriptor.value;
      if (!Reflect.has(target, 'rpcEventHandlerMethods')) {
        Reflect.set(target, 'rpcEventHandlerMethods', []);
      }
      if (!Reflect.has(target, 'createEventHandler')) {
        Reflect.set(target, 'createEventHandler', this.createEventHandler);
      }
      const rpcEventHandlerMethods: RpcEventHandlerMethodInfo[] = Reflect.get(
        target,
        'rpcEventHandlerMethods',
      );

      const sourceServices = Object.keys(eventsMapping)
      sourceServices.forEach((sourceService: string) => {
        const eventTypes = eventsMapping[sourceService];
        eventTypes.forEach((eventType: string) => {
          const args = { sourceService, eventType }
          rpcEventHandlerMethods.push({
            sourceService,
            eventType,
            handlerType,
            reliableDelivery,
            requeueOnError,
            handlerName: propertyKey.toString(),
            // @ts-ignore
            handlerFunction: originalFunc(args),
          });
        });
      })

      Reflect.set(target, 'rpcEventHandlerMethods', rpcEventHandlerMethods);
    };
  };


  public eventHandlerClasslogClass<T extends new (...args: any[]) => {}>(
    constructor: T,
  ) {
    // tslint:disable-next-line: no-this-assignment
    // const that = this
    return class extends constructor {
      constructor(...args: any[]) {
        super(...args);
        if (!Reflect.has(this, 'rpcEventHandlerMethods') || !Reflect.has(this, 'createEventHandler')) {
          return;
        }
        const rpcEventHandlerMethods: RpcEventHandlerMethodInfo[] = Reflect.get(
          this,
          'rpcEventHandlerMethods',
        ) as RpcEventHandlerMethodInfo[];
        const createEventHandler: any = Reflect.get(
          this,
          'createEventHandler',
        );
        rpcEventHandlerMethods.forEach((methods: RpcEventHandlerMethodInfo) => {
          createEventHandler({
            target: this,
            ...methods,
          });
        });
      }
    };
  }

  public createEventHandler = async (eventHandlerInfo: EventHandlerArgs) => {
    const {
      target,
      sourceService,
      eventType,
      handlerType,
      handlerName,
      handlerFunction,
      reliableDelivery,
    } = eventHandlerInfo;
    let exclusive = false;
    const serviceName = this.serviceName;
    let queueName: string;
    const handlerNameString = handlerName.toString();
    if (handlerType === EventHandlerType.SERVICE_POOL) {
      queueName = `evt-${ sourceService }-${ eventType }--${ serviceName }.${ handlerNameString }`;
    } else if (handlerType === EventHandlerType.SINGLETON) {
      queueName = `evt-${ sourceService }-${ eventType }`;
    } else {
      if (reliableDelivery) {
        throw new EventHandlerConfigurationError(
          `You are using the default broadcast identifier 
          which is not compatible with reliable delivery.`,
        );
      }
      queueName = `evt-${ sourceService }-${ eventType }--${ serviceName }.${ handlerNameString }-${ uuid() }`;
    }
    const exchangeName = `${ sourceService }.events`;
    /**
     * queues for handlers without reliable delivery should be marked as
     * autoDelete so they're removed when the consumer disconnects
     */
    const autoDelete = !reliableDelivery;
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
      this.logger(`event channel ${ queueName } close`);
      this.reestablishConnection();
    });
    eventChannel.on('error', () => {
      this.logger(`event channel ${ queueName } error`);
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
        let messageContent = this.parseMessage(message);
        if (this.entrypointHooks.processResponse) {
          messageContent = this.entrypointHooks.processResponse(messageContent);
        }
        this.requestLogger(
          'event %s emitted by %s payload: %o',
          eventType,
          sourceService,
          messageContent,
        );
        handlerFunction.apply(target, [messageContent, message?.properties.headers]);
      },
      {
        noAck: true,
      },
    );
  };

  protected dispatchEvent = (
    eventType: string,
    eventData: any,
    workerCtx: any = {},
  ) => {
    const exchangeName = `${ this.serviceName }.events`;
    this.channel!.publish(
      exchangeName,
      eventType,
      Buffer.from(JSON.stringify(eventData)),
      {
        headers: workerCtx,
      },
    );
  };

  protected callRpc = async (
    serviceName: string,
    functionName: string,
    payload: RpcPayload = {},
    workerCtx: any = {},
  ) => {
    const routingKey = `${ serviceName }.${ functionName }`;
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
          priority: workerCtx.priority || 0,
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

  private replyHealthCheck = (msg: any) => {
    this.channel?.sendToQueue(
      `rpc.reply-${ this.healthcheckRouteKey }-${ this.replyToId }`,
      Buffer.from('ok'),
      {
        correlationId: msg.properties.correlationId,
      }
    );
  }

  private consumeHealthcheck = (msg: any) => {
    const correlationId = msg.properties.correlationId;

    if (correlationId in this.rpcResolvers) {
      // content is 'ok'
      const content = msg.content.toString();
      const resolver = this.rpcResolvers[correlationId];
      delete this.rpcResolvers[correlationId];
      resolver.resolve(content);
    }
  }

  private prepareHealthcheck = async () => {
    await this.channel?.assertExchange(this.serviceName, 'direct');
    // healthcheck rpc queue
    const healthCheckQueueName = `rpc.${ this.healthcheckRouteKey }-${ this.replyToId }`;
    const healthCheckQueueInfo = await this.channel?.assertQueue(healthCheckQueueName, {
      exclusive: true,
      autoDelete: true,
      durable: false,
    });

    await this.channel?.bindQueue(
      healthCheckQueueInfo?.queue || '',
      this.serviceName,
      this.healthcheckRouteKey
    );
    await this.channel?.consume(healthCheckQueueInfo?.queue || '', this.replyHealthCheck, {
      noAck: true,
    });

    // healthcheck rpc queue reply
    const healthCheckQueueNameReply = `rpc.reply-${ this.healthcheckRouteKey }-${ this.replyToId }`;
    const healthCheckQueueInfoReply = await this.channel?.assertQueue(
      healthCheckQueueNameReply,
      {
        exclusive: true,
        autoDelete: true,
        durable: false,
      }
    );
    await this.channel?.consume(healthCheckQueueInfoReply?.queue || '', this.consumeHealthcheck, {
      noAck: true,
    });
  }


  /**
   * kinopio.healthcheck()
   * .then(response => {
   *   res.send(response);
   * })
   * .catch(error => {
   *   ...handle error action
   * });
   */
  public healthcheck = (
    payload: RpcPayload = {},
    workerCtx: object = {}
  ) => {
    const correlationId = uuid();

    return new Promise((resolve, reject) => {
      if (!this.channel) {
        throw new Error('no channel, call rpcSetup() first');
      }

      this.rpcResolvers[correlationId] = { resolve, reject };
      const { args = [], kwargs = {} } = payload;
      const rpcPayload = { args, kwargs };

      this.logger('%s: %s() payload: %o', correlationId, this.healthcheckRouteKey, rpcPayload);
      this.logger('workerCtx: %o', workerCtx);

      this.channel.publish(
        this.serviceName,
        this.healthcheckRouteKey,
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
  }

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

    await this.prepareHealthcheck();

    this.logger(
      `connected to amqp server: amqp://${ this.mqOptions.hostname }:${ this.mqOptions.port }/${ this.mqOptions.vhost }`,
    );

    const queueName = `${ this.queuePrefix }-${ this.replyToId }`;
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
      `connection closed, try to connect in ${ this.reconnectInterval / 1000
      } seconds`,
    );
    setTimeout(this.reconnect, this.reconnectInterval);
  }

  protected reconnect = async () => {
    this.logger(
      `trying to reconnect to amqp://${ this.mqOptions.hostname }:${ this.mqOptions.port }/${ this.mqOptions.vhost }`,
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
          `failed to reconnect after ${ this.reconnectMaxAttemptes } tries`,
        );
        throw new Error(
          `AMQP disconnected after ${ this.reconnectMaxAttemptes } attempts`,
        );
      }
      this.logger(
        `could not connect, trying again in ${ timeout / 1000 } seconds`,
      );
      setTimeout(this.reconnect, this.reconnectInterval);
    }
  };
}
