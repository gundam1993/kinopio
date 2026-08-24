import { randomUUID as uuid } from 'crypto';
import * as amqp from 'amqplib';
import { context, propagation } from '@opentelemetry/api';

const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 5000;

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

interface EventsMapping {
  [key: string]: string[];
}

export class RpcError extends Error {
  code: string;
  deliveryState: DeliveryState = 'confirmed';
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

export type RpcContentType = 'application/xjson' | 'application/json';
export type DeliveryState = 'not_sent' | 'confirmed' | 'unknown';
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closing'
  | 'closed';

export type RpcOutcome =
  | 'success'
  | 'remote_error'
  | 'timeout'
  | 'cancelled'
  | 'invalid_argument'
  | 'not_ready'
  | 'overloaded'
  | 'publish_error'
  | 'connection_lost'
  | 'closed'
  | 'serialization_error'
  | 'response_processing_error';

export class KinopioError extends Error {
  constructor(
    message: string,
    public code: string,
    public deliveryState: DeliveryState,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RpcTimeoutError extends KinopioError {
  constructor(service: string, method: string, timeoutMs: number) {
    super(
      `RPC ${service}.${method} timed out after ${timeoutMs}ms`,
      'RPC_TIMEOUT',
      'unknown',
    );
  }
}

export class RpcConnectionLostError extends KinopioError {
  constructor(message: string = 'AMQP connection lost while RPC was pending') {
    super(message, 'RPC_CONNECTION_LOST', 'unknown');
  }
}

export class RpcNotReadyError extends KinopioError {
  constructor() {
    super('AMQP channel is not ready', 'RPC_NOT_READY', 'not_sent');
  }
}

export class RpcOverloadedError extends KinopioError {
  constructor(maxInflight: number) {
    super(
      `RPC in-flight limit of ${maxInflight} has been reached`,
      'RPC_OVERLOADED',
      'not_sent',
    );
  }
}

export class RpcPublishError extends KinopioError {
  public cause?: unknown;

  constructor(cause: unknown) {
    super('Failed to publish RPC request', 'RPC_PUBLISH_ERROR', 'not_sent');
    this.cause = cause;
  }
}

export class RpcSerializationError extends KinopioError {
  public cause?: unknown;
  public contentType?: string;

  constructor(message: string, contentType?: string, cause?: unknown) {
    super(message, 'RPC_SERIALIZATION_ERROR', 'not_sent');
    this.contentType = contentType;
    this.cause = cause;
  }
}

export class RpcContentTypeMismatchError extends RpcSerializationError {
  constructor(expected: RpcContentType, actual: string) {
    super(
      `RPC response content type mismatch: expected ${expected}, received ${actual}`,
      actual,
    );
    this.code = 'RPC_CONTENT_TYPE_MISMATCH';
  }
}

export class RpcCancelledError extends KinopioError {
  constructor(deliveryState: DeliveryState) {
    super('RPC call was cancelled', 'RPC_CANCELLED', deliveryState);
  }
}

export class RpcInvalidArgumentError extends KinopioError {
  constructor(message: string) {
    super(message, 'RPC_INVALID_ARGUMENT', 'not_sent');
  }
}

export class RpcClosedError extends KinopioError {
  constructor(deliveryState: DeliveryState = 'unknown') {
    super('Kinopio client is closing', 'RPC_CLOSED', deliveryState);
  }
}

export interface RpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  contentType?: RpcContentType;
}

export interface RpcStartEvent {
  clientService: string;
  service: string;
  method: string;
  contentType: RpcContentType;
  requestBytes: number;
  inflight: number;
}

export interface RpcFinishEvent extends RpcStartEvent {
  outcome: RpcOutcome;
  durationMs: number;
  deliveryState: DeliveryState;
  inflight: number;
  responseContentType?: string;
  responseContentTypeStatus?: ResponseContentTypeStatus;
  responseBytes?: number;
  decodeDurationMs?: number;
  legacyTags?: Array<'datetime' | 'date' | 'decimal'>;
}

export type ResponseContentTypeStatus =
  | 'matched'
  | 'missing'
  | 'mismatch'
  | 'unknown';

export interface ConnectionStateEvent {
  previous: ConnectionState;
  current: ConnectionState;
}

export interface LateReplyEvent {
  contentType?: string;
}

export interface KinopioObserver {
  onConnectionStateChange?: (event: ConnectionStateEvent) => void;
  onRpcStart?: (event: RpcStartEvent) => void;
  onRpcFinish?: (event: RpcFinishEvent) => void;
  onLateReply?: (event: LateReplyEvent) => void;
}

export interface KinopioSnapshot {
  state: ConnectionState;
  pendingRpc: number;
  replyConsumerReady: boolean;
  readyEventConsumers: number;
  expectedEventConsumers: number;
  reconnectAttempts: number;
  lateReplies: number;
  observerErrors: number;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
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

function containsKombuTypeEnvelope(value: any): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, '__type__') &&
    Object.prototype.hasOwnProperty.call(value, '__value__')
  ) {
    return true;
  }
  return Object.keys(value).some((key) =>
    containsKombuTypeEnvelope(value[key]),
  );
}

export interface RpcPayload {
  args?: any[];
  kwargs?: object;
}

export type RpcMethod<T = any> = (
  payload?: RpcPayload,
  options?: RpcCallOptions,
) => Promise<T>;

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
  rpc?: {
    defaultTimeoutMs?: number;
    healthcheckTimeoutMs?: number;
    maxInflight?: number;
  };
  serialization?: {
    defaultContentType?: RpcContentType;
    contentTypeByTarget?: Record<string, RpcContentType>;
  };
  observer?: KinopioObserver;
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  service: string;
  method: string;
  contentType: RpcContentType;
  requestBytes: number;
  startedAt: [number, number];
  deliveryState: DeliveryState;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface ResponseMetadata {
  contentType: string;
  contentTypeStatus: ResponseContentTypeStatus;
  payloadBytes: number;
  decodeDurationMs: number;
  legacyTags: Array<'datetime' | 'date' | 'decimal'>;
}

interface ParsedMessage extends ResponseMetadata {
  content: any;
  contentType: RpcContentType;
  contentTypeStatus: 'matched' | 'missing';
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
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.Channel | undefined;
  private eventChannels: amqp.Channel[];
  private entrypointHooks: EntrypointsHooks;
  private queuePrefix: string;
  private rpcResolvers: Map<string, PendingCall> = new Map();
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
  private eventChannelsArgs: { [key: string]: EventHandlerArgs } = {};
  private defaultTimeoutMs?: number;
  private healthcheckTimeoutMs: number;
  private maxInflight?: number;
  private defaultContentType: RpcContentType;
  private contentTypeByTarget: Record<string, RpcContentType>;
  private observer?: KinopioObserver;
  private connectionState: ConnectionState = 'disconnected';
  private replyConsumerReady: boolean = false;
  private readyEventConsumers: number = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closing: boolean = false;
  private lateReplies: number = 0;
  private observerErrors: number = 0;
  private lastConnectedAt?: number;
  private lastDisconnectedAt?: number;

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
      rpc,
      serialization,
      observer,
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
    this.defaultTimeoutMs = rpc?.defaultTimeoutMs;
    this.healthcheckTimeoutMs =
      rpc?.healthcheckTimeoutMs ||
      (rpc?.defaultTimeoutMs && rpc.defaultTimeoutMs > 0
        ? rpc.defaultTimeoutMs
        : DEFAULT_HEALTHCHECK_TIMEOUT_MS);
    this.maxInflight = rpc?.maxInflight;
    this.defaultContentType =
      serialization?.defaultContentType || 'application/xjson';
    this.contentTypeByTarget = serialization?.contentTypeByTarget || {};
    this.observer = observer;

    if (
      this.defaultTimeoutMs !== undefined &&
      (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs < 0)
    ) {
      throw new Error(
        'rpc.defaultTimeoutMs must be a finite non-negative number',
      );
    }
    if (
      this.maxInflight !== undefined &&
      (!Number.isInteger(this.maxInflight) || this.maxInflight <= 0)
    ) {
      throw new Error('rpc.maxInflight must be a positive integer');
    }
    if (
      rpc?.healthcheckTimeoutMs !== undefined &&
      (!Number.isFinite(rpc.healthcheckTimeoutMs) ||
        rpc.healthcheckTimeoutMs <= 0)
    ) {
      throw new Error(
        'rpc.healthcheckTimeoutMs must be a finite positive number',
      );
    }
    this.eventChannels = [];
    this.eventChannelsArgs = {};
  }

  public async connect(): Promise<void> {
    if (this.closing || this.connectionState === 'closed') {
      throw new RpcClosedError();
    }
    this.setConnectionState('connecting');
    try {
      await this.connectMq();
      if (Object.keys(this.eventChannelsArgs).length) {
        await Promise.all(
          Object.values(this.eventChannelsArgs).map((element) => {
            return this.createEventHandler(element);
          }),
        );
      }
      this.lastConnectedAt = Date.now();
      this.setConnectionState('ready');
    } catch (error) {
      this.lastDisconnectedAt = Date.now();
      this.setConnectionState(
        this.reconnectLock ? 'reconnecting' : 'disconnected',
      );
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.connectionState === 'closed') {
      return;
    }
    this.closing = true;
    this.setConnectionState('closing');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectLock = false;
    this.rejectAllPending(() => new RpcClosedError(), 'closed');
    this.logger('disconnecting from amqp server...');

    const eventChannels = this.eventChannels.splice(0);
    await Promise.all(
      eventChannels.map(async (eventChannel) => {
        try {
          await eventChannel.close();
        } catch (_) {
          return;
        }
      }),
    );

    const channel = this.channel;
    this.channel = undefined;
    if (channel) {
      try {
        await channel.close();
      } catch (_) {
        // The transport may already be closed.
      }
    }

    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      try {
        await connection.close();
      } catch (_) {
        // The transport may already be closed.
      }
    }
    this.replyConsumerReady = false;
    this.readyEventConsumers = 0;
    this.setConnectionState('closed');
    this.logger('amqp server disconnected');
  }

  public isReady(): boolean {
    return this.connectionState === 'ready' && this.replyConsumerReady;
  }

  public getSnapshot(): KinopioSnapshot {
    return {
      state: this.connectionState,
      pendingRpc: this.rpcResolvers.size,
      replyConsumerReady: this.replyConsumerReady,
      readyEventConsumers: this.readyEventConsumers,
      expectedEventConsumers: Object.keys(this.eventChannelsArgs).length,
      reconnectAttempts: this.numAttempts,
      lateReplies: this.lateReplies,
      observerErrors: this.observerErrors,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
    };
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
                return (payload?: RpcPayload, options?: RpcCallOptions) => {
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
                    this.logger('propagate context', traceparent, tracestate);
                  }

                  return this.callRpc(
                    serviceTarget.serviceName.toString(),
                    functionName.toString(),
                    payload,
                    target.workerCtx,
                    options,
                  );
                };
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

      const sourceServices = Object.keys(eventsMapping);
      sourceServices.forEach((sourceService: string) => {
        const eventTypes = eventsMapping[sourceService];
        eventTypes.forEach((eventType: string) => {
          const args = { sourceService, eventType };
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
      });

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
        if (
          !Reflect.has(this, 'rpcEventHandlerMethods') ||
          !Reflect.has(this, 'createEventHandler')
        ) {
          return;
        }
        const rpcEventHandlerMethods: RpcEventHandlerMethodInfo[] = Reflect.get(
          this,
          'rpcEventHandlerMethods',
        ) as RpcEventHandlerMethodInfo[];
        const createEventHandler: any = Reflect.get(this, 'createEventHandler');
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
    const autoDelete = !reliableDelivery;
    exclusive = handlerType === EventHandlerType.BROADCAST;
    if (reliableDelivery) {
      exclusive = false;
    }
    this.eventChannelsArgs[queueName] = eventHandlerInfo;
    if (!this.connection) {
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
        if (!message) {
          return;
        }
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
        handlerFunction.apply(target, [
          messageContent,
          message?.properties.headers,
        ]);
      },
      {
        noAck: true,
      },
    );
    this.readyEventConsumers += 1;
  };

  protected dispatchEvent = (
    eventType: string,
    eventData: any,
    workerCtx: any = {},
  ) => {
    const exchangeName = `${this.serviceName}.events`;
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
    options: RpcCallOptions = {},
  ): Promise<any> => {
    const routingKey = `${serviceName}.${functionName}`;
    const correlationId = uuid();
    const contentType = this.resolveContentType(
      serviceName,
      functionName,
      workerCtx,
      options,
    );
    const timeoutMs =
      options.timeoutMs === undefined
        ? this.defaultTimeoutMs
        : options.timeoutMs;

    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    ) {
      const invalidArgumentError = new RpcInvalidArgumentError(
        'RPC timeoutMs must be a finite non-negative number',
      );
      this.observeRejectedCall(
        serviceName,
        functionName,
        contentType,
        0,
        'invalid_argument',
        invalidArgumentError,
      );
      throw invalidArgumentError;
    }

    const { args = [], kwargs = {} } = payload || {};
    const rpcPayload = { args, kwargs };
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(rpcPayload));
    } catch (error) {
      const serializationError = new RpcSerializationError(
        `Unable to serialize RPC request ${routingKey}`,
        contentType,
        error,
      );
      this.observeRejectedCall(
        serviceName,
        functionName,
        contentType,
        0,
        'serialization_error',
        serializationError,
      );
      throw serializationError;
    }

    if (options.signal?.aborted) {
      const cancelledError = new RpcCancelledError('not_sent');
      this.observeRejectedCall(
        serviceName,
        functionName,
        contentType,
        body.length,
        'cancelled',
        cancelledError,
      );
      throw cancelledError;
    }

    const channel = this.channel;
    if (!channel || this.closing || this.connectionState === 'closed') {
      const notReadyError = this.closing
        ? new RpcClosedError('not_sent')
        : new RpcNotReadyError();
      this.observeRejectedCall(
        serviceName,
        functionName,
        contentType,
        body.length,
        this.closing ? 'closed' : 'not_ready',
        notReadyError,
      );
      throw notReadyError;
    }

    if (
      this.maxInflight !== undefined &&
      this.rpcResolvers.size >= this.maxInflight
    ) {
      const overloadedError = new RpcOverloadedError(this.maxInflight);
      this.observeRejectedCall(
        serviceName,
        functionName,
        contentType,
        body.length,
        'overloaded',
        overloadedError,
      );
      throw overloadedError;
    }

    this.entrypointHooks.onRequest &&
      this.entrypointHooks.onRequest(serviceName, functionName, rpcPayload);

    this.requestLogger(
      '%s: %s() payload: %o',
      correlationId,
      routingKey,
      rpcPayload,
    );
    this.logger('workerCtx: %o', workerCtx);
    const headers = { ...(workerCtx || {}) };
    delete headers.content_type;

    return new Promise((resolve, reject) => {
      const pendingCall: PendingCall = {
        resolve,
        reject,
        contentType,
        service: serviceName,
        method: functionName,
        requestBytes: body.length,
        startedAt: process.hrtime(),
        deliveryState: 'not_sent',
        signal: options.signal,
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        pendingCall.timeout = setTimeout(() => {
          this.settlePending(
            correlationId,
            'timeout',
            new RpcTimeoutError(serviceName, functionName, timeoutMs),
          );
        }, timeoutMs);
      }

      if (options.signal) {
        pendingCall.abortHandler = () => {
          this.settlePending(
            correlationId,
            'cancelled',
            new RpcCancelledError(pendingCall.deliveryState),
          );
        };
        options.signal.addEventListener('abort', pendingCall.abortHandler, {
          once: true,
        });
      }

      this.rpcResolvers.set(correlationId, pendingCall);
      this.safeObserve('onRpcStart', this.rpcStartEvent(pendingCall));

      try {
        channel.publish('nameko-rpc', routingKey, body, {
          correlationId,
          contentType,
          headers,
          replyTo: this.replyToId,
          contentEncoding: 'utf-8',
          deliveryMode: 2,
          priority: workerCtx.priority || 0,
        });
        pendingCall.deliveryState = 'unknown';
      } catch (error) {
        this.settlePending(
          correlationId,
          'publish_error',
          new RpcPublishError(error),
        );
      }
    });
  };

  protected consumeQueue = (
    message: any,
    connection: amqp.ChannelModel | undefined = this.connection,
    channel: amqp.Channel | undefined = this.channel,
  ) => {
    if (!message) {
      this.handleTransportFailure(
        'RPC reply consumer cancelled',
        connection,
        channel,
      );
      return;
    }
    const { correlationId } = message.properties;

    const pendingCall = this.rpcResolvers.get(correlationId);
    if (!pendingCall) {
      this.lateReplies += 1;
      this.safeObserve('onLateReply', {
        contentType: message.properties.contentType,
      });
      return;
    }
    pendingCall.deliveryState = 'confirmed';

    const decodeStartedAt = process.hrtime();
    let parsedMessage: ParsedMessage;
    try {
      parsedMessage = this.decodeMessage(message, pendingCall.contentType);
    } catch (error) {
      const serializationError =
        error instanceof KinopioError
          ? error
          : new RpcSerializationError(
              'Unable to decode RPC response',
              message.properties.contentType,
              error,
            );
      this.settlePending(
        correlationId,
        'serialization_error',
        serializationError,
        undefined,
        this.failedResponseMetadata(
          message,
          pendingCall.contentType,
          decodeStartedAt,
        ),
      );
      return;
    }

    const messageContent = parsedMessage.content;
    if (
      !messageContent ||
      typeof messageContent !== 'object' ||
      Array.isArray(messageContent)
    ) {
      this.settlePending(
        correlationId,
        'serialization_error',
        new RpcSerializationError(
          'RPC response must be a Nameko result/error envelope',
          parsedMessage.contentType,
        ),
        undefined,
        parsedMessage,
      );
      return;
    }
    this.responseLogger('%s: payload: %o', correlationId, messageContent);

    if (messageContent.error) {
      this.settlePending(
        correlationId,
        'remote_error',
        new RpcError(
          messageContent.error.value,
          messageContent.error.exc_args,
          messageContent.error.exc_type,
          messageContent.error.exc_path,
        ),
        undefined,
        parsedMessage,
      );
      return;
    }

    try {
      if (this.entrypointHooks.processResponse) {
        messageContent.result = this.entrypointHooks.processResponse(
          messageContent.result,
        );
      }
      this.entrypointHooks.onResponse &&
        this.entrypointHooks.onResponse(messageContent.result);
    } catch (error) {
      this.settlePending(
        correlationId,
        'response_processing_error',
        error,
        undefined,
        parsedMessage,
      );
      return;
    }

    this.settlePending(
      correlationId,
      'success',
      undefined,
      messageContent.result,
      parsedMessage,
    );
  };

  private replyHealthCheck = (msg: any) => {
    if (!msg) {
      this.handleTransportFailure('healthcheck request consumer cancelled');
      return;
    }
    this.channel?.sendToQueue(
      `rpc.reply-${this.healthcheckRouteKey}-${this.replyToId}`,
      Buffer.from('ok'),
      {
        correlationId: msg.properties.correlationId,
      },
    );
  };

  private consumeHealthcheck = (msg: any) => {
    if (!msg) {
      this.handleTransportFailure('healthcheck reply consumer cancelled');
      return;
    }
    const correlationId = msg.properties.correlationId;

    if (this.rpcResolvers.has(correlationId)) {
      // content is 'ok'
      const content = msg.content.toString();
      this.settlePending(correlationId, 'success', undefined, content);
    }
  };

  private prepareHealthcheck = async () => {
    const connection = this.connection;
    const channel = this.channel;
    if (!channel) {
      throw new RpcNotReadyError();
    }

    await channel.assertExchange(this.serviceName, 'direct');
    // healthcheck rpc queue
    const healthCheckQueueName = `rpc.${this.healthcheckRouteKey}-${this.replyToId}`;
    const healthCheckQueueInfo = await channel.assertQueue(
      healthCheckQueueName,
      {
        exclusive: true,
        autoDelete: true,
        durable: false,
      },
    );

    await channel.bindQueue(
      healthCheckQueueInfo?.queue || '',
      this.serviceName,
      this.healthcheckRouteKey,
    );
    await channel.consume(
      healthCheckQueueInfo?.queue || '',
      (message) => {
        if (!message) {
          this.handleTransportFailure(
            'healthcheck request consumer cancelled',
            connection,
            channel,
          );
          return;
        }
        this.replyHealthCheck(message);
      },
      {
        noAck: true,
      },
    );

    // healthcheck rpc queue reply
    const healthCheckQueueNameReply = `rpc.reply-${this.healthcheckRouteKey}-${this.replyToId}`;
    const healthCheckQueueInfoReply = await channel.assertQueue(
      healthCheckQueueNameReply,
      {
        exclusive: true,
        autoDelete: true,
        durable: false,
      },
    );
    await channel.consume(
      healthCheckQueueInfoReply?.queue || '',
      (message) => {
        if (!message) {
          this.handleTransportFailure(
            'healthcheck reply consumer cancelled',
            connection,
            channel,
          );
          return;
        }
        this.consumeHealthcheck(message);
      },
      {
        noAck: true,
      },
    );
  };

  /**
   * kinopio.healthcheck()
   * .then(response => {
   *   res.send(response);
   * })
   * .catch(error => {
   *   ...handle error action
   * });
   */
  // tslint:disable-next-line:member-ordering
  public healthcheck = (payload: RpcPayload = {}, workerCtx: object = {}) => {
    const correlationId = uuid();

    return new Promise((resolve, reject) => {
      const channel = this.channel;
      if (!channel || this.closing || this.connectionState === 'closed') {
        const notReadyError = this.closing
          ? new RpcClosedError('not_sent')
          : new RpcNotReadyError();
        this.observeRejectedCall(
          this.serviceName,
          this.healthcheckRouteKey,
          'application/xjson',
          0,
          this.closing ? 'closed' : 'not_ready',
          notReadyError,
        );
        reject(notReadyError);
        return;
      }

      const { args = [], kwargs = {} } = payload;
      const rpcPayload = { args, kwargs };
      const body = Buffer.from(JSON.stringify(rpcPayload));
      if (
        this.maxInflight !== undefined &&
        this.rpcResolvers.size >= this.maxInflight
      ) {
        const overloadedError = new RpcOverloadedError(this.maxInflight);
        this.observeRejectedCall(
          this.serviceName,
          this.healthcheckRouteKey,
          'application/xjson',
          body.length,
          'overloaded',
          overloadedError,
        );
        reject(overloadedError);
        return;
      }

      const pendingCall: PendingCall = {
        resolve,
        reject,
        service: this.serviceName,
        method: this.healthcheckRouteKey,
        contentType: 'application/xjson',
        requestBytes: body.length,
        startedAt: process.hrtime(),
        deliveryState: 'not_sent',
      };
      pendingCall.timeout = setTimeout(() => {
        this.settlePending(
          correlationId,
          'timeout',
          new RpcTimeoutError(
            this.serviceName,
            this.healthcheckRouteKey,
            this.healthcheckTimeoutMs,
          ),
        );
      }, this.healthcheckTimeoutMs);
      this.rpcResolvers.set(correlationId, pendingCall);
      this.safeObserve('onRpcStart', this.rpcStartEvent(pendingCall));

      this.logger(
        '%s: %s() payload: %o',
        correlationId,
        this.healthcheckRouteKey,
        rpcPayload,
      );
      this.logger('workerCtx: %o', workerCtx);

      try {
        channel.publish(this.serviceName, this.healthcheckRouteKey, body, {
          correlationId,
          replyTo: this.replyToId,
          headers: workerCtx,
          contentEncoding: 'utf-8',
          contentType: 'application/xjson',
          deliveryMode: 2,
          priority: 0,
        });
        pendingCall.deliveryState = 'unknown';
      } catch (error) {
        this.settlePending(
          correlationId,
          'publish_error',
          new RpcPublishError(error),
        );
      }
    });
  };

  // tslint:disable-next-line:member-ordering
  protected connectMq = async (): Promise<void> => {
    const connection = await amqp.connect(this.mqOptions);
    this.connection = connection;

    connection.on('close', () => {
      this.logger('connection close');
      this.handleTransportFailure('connection closed', connection);
    });

    connection.on('error', () => {
      this.logger('connection error');
      this.handleTransportFailure('connection error', connection);
    });

    const channel = await connection.createChannel();
    this.channel = channel;
    channel.on('close', () => {
      this.logger('channel close');
      this.handleTransportFailure('channel closed', connection, channel);
    });
    channel.on('error', () => {
      this.logger('channel error');
      this.handleTransportFailure('channel error', connection, channel);
    });

    await this.prepareHealthcheck();

    this.logger(
      `connected to amqp server: amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`,
    );

    const queueName = `${this.queuePrefix}-${this.replyToId}`;
    const queueInfo = await channel.assertQueue(queueName, {
      exclusive: true,
      autoDelete: true,
      durable: false,
    });

    await channel.bindQueue(queueInfo.queue, 'nameko-rpc', this.replyToId);
    await channel.consume(
      queueInfo.queue,
      (message) => this.consumeQueue(message, connection, channel),
      { noAck: true },
    );
    this.replyConsumerReady = true;
    this.numAttempts = 0;
    await this.userCallbackOnConnect(connection, channel);
  };

  // tslint:disable-next-line:member-ordering
  protected parseMessage(message: any) {
    return this.decodeMessage(message).content;
  }

  private decodeMessage(
    message: any,
    expectedContentType?: RpcContentType,
  ): ParsedMessage {
    const startedAt = process.hrtime();
    const rawMessageContent = message.content.toString();
    const actualContentType = message.properties?.contentType as
      | string
      | undefined;
    const contentTypeStatus = actualContentType ? 'matched' : 'missing';
    const contentType = actualContentType || 'application/xjson';

    if (
      contentType !== 'application/json' &&
      contentType !== 'application/xjson'
    ) {
      throw new RpcSerializationError(
        `Unsupported RPC response content type: ${contentType}`,
        contentType,
      );
    }
    if (expectedContentType && actualContentType !== undefined) {
      if (contentType !== expectedContentType) {
        throw new RpcContentTypeMismatchError(expectedContentType, contentType);
      }
    }

    const legacyTags: Array<'datetime' | 'date' | 'decimal'> = [];
    let content: any;
    try {
      if (contentType === 'application/json') {
        content = JSON.parse(rawMessageContent);
        if (
          rawMessageContent.includes('"__type__"') &&
          rawMessageContent.includes('"__value__"') &&
          containsKombuTypeEnvelope(content)
        ) {
          throw new RpcSerializationError(
            'Standard JSON response contains a Kombu typed envelope',
            contentType,
          );
        }
      } else {
        const tagPattern = /"!!(datetime|date|decimal) /g;
        let tagMatch = tagPattern.exec(rawMessageContent);
        while (tagMatch !== null) {
          legacyTags.push(tagMatch[1] as 'datetime' | 'date' | 'decimal');
          tagMatch = tagPattern.exec(rawMessageContent);
        }
        content = legacyTags.length
          ? JSON.parse(rawMessageContent, parseXJson)
          : JSON.parse(rawMessageContent);
      }
    } catch (error) {
      if (error instanceof KinopioError) {
        throw error;
      }
      throw new RpcSerializationError(
        `Invalid ${contentType} RPC response`,
        contentType,
        error,
      );
    }

    return {
      content,
      contentType,
      contentTypeStatus,
      payloadBytes: message.content.length,
      decodeDurationMs: this.elapsedMs(startedAt),
      legacyTags: Array.from(new Set(legacyTags)),
    };
  }

  private resolveContentType(
    serviceName: string,
    functionName: string,
    workerCtx: any,
    options: RpcCallOptions,
  ): RpcContentType {
    const target = `${serviceName}.${functionName}`;
    // workerCtx.content_type is a compatibility bridge only. New callers
    // should use RpcCallOptions or serialization.contentTypeByTarget.
    const contentType =
      options.contentType ||
      this.contentTypeByTarget[target] ||
      workerCtx?.content_type ||
      this.defaultContentType;
    if (
      contentType !== 'application/json' &&
      contentType !== 'application/xjson'
    ) {
      throw new RpcSerializationError(
        `Unsupported RPC request content type: ${contentType}`,
        contentType,
      );
    }
    return contentType;
  }

  private settlePending(
    correlationId: string,
    outcome: RpcOutcome,
    error?: any,
    result?: any,
    responseMetadata?: ResponseMetadata,
  ): boolean {
    const pendingCall = this.rpcResolvers.get(correlationId);
    if (!pendingCall) {
      return false;
    }

    this.rpcResolvers.delete(correlationId);
    if (pendingCall.timeout) {
      clearTimeout(pendingCall.timeout);
    }
    if (pendingCall.signal && pendingCall.abortHandler) {
      pendingCall.signal.removeEventListener('abort', pendingCall.abortHandler);
    }

    if (outcome === 'success' || outcome === 'remote_error') {
      pendingCall.deliveryState = 'confirmed';
    }
    if (
      error instanceof KinopioError &&
      error.deliveryState === 'not_sent' &&
      pendingCall.deliveryState !== 'not_sent'
    ) {
      error.deliveryState = pendingCall.deliveryState;
    }

    const finishEvent: RpcFinishEvent = {
      ...this.rpcStartEvent(pendingCall),
      outcome,
      durationMs: this.elapsedMs(pendingCall.startedAt),
      deliveryState: pendingCall.deliveryState,
      inflight: this.rpcResolvers.size,
    };
    if (responseMetadata) {
      finishEvent.responseContentType = responseMetadata.contentType;
      finishEvent.responseContentTypeStatus =
        responseMetadata.contentTypeStatus;
      finishEvent.responseBytes = responseMetadata.payloadBytes;
      finishEvent.decodeDurationMs = responseMetadata.decodeDurationMs;
      finishEvent.legacyTags = responseMetadata.legacyTags;
    }
    this.safeObserve('onRpcFinish', finishEvent);

    if (error !== undefined) {
      pendingCall.reject(error);
    } else {
      pendingCall.resolve(result);
    }
    return true;
  }

  private rejectAllPending(
    errorFactory: () => KinopioError,
    outcome: RpcOutcome,
  ): void {
    Array.from(this.rpcResolvers.keys()).forEach((correlationId) => {
      this.settlePending(correlationId, outcome, errorFactory());
    });
  }

  private failedResponseMetadata(
    message: any,
    expectedContentType: RpcContentType,
    startedAt: [number, number],
  ): ResponseMetadata {
    const actualContentType = message.properties?.contentType as
      | string
      | undefined;
    let contentTypeStatus: ResponseContentTypeStatus;
    if (!actualContentType) {
      contentTypeStatus = 'missing';
    } else if (
      actualContentType !== 'application/json' &&
      actualContentType !== 'application/xjson'
    ) {
      contentTypeStatus = 'unknown';
    } else if (actualContentType !== expectedContentType) {
      contentTypeStatus = 'mismatch';
    } else {
      contentTypeStatus = 'matched';
    }
    return {
      contentTypeStatus,
      contentType: actualContentType || 'application/xjson',
      payloadBytes: message.content.length,
      decodeDurationMs: this.elapsedMs(startedAt),
      legacyTags: [],
    };
  }

  private rpcStartEvent(pendingCall: PendingCall): RpcStartEvent {
    return {
      clientService: this.serviceName,
      service: pendingCall.service,
      method: pendingCall.method,
      contentType: pendingCall.contentType,
      requestBytes: pendingCall.requestBytes,
      inflight: this.rpcResolvers.size,
    };
  }

  private observeRejectedCall(
    service: string,
    method: string,
    contentType: RpcContentType,
    requestBytes: number,
    outcome: RpcOutcome,
    error: KinopioError,
  ): void {
    const startEvent: RpcStartEvent = {
      service,
      method,
      contentType,
      requestBytes,
      clientService: this.serviceName,
      inflight: this.rpcResolvers.size,
    };
    this.safeObserve('onRpcStart', startEvent);
    this.safeObserve('onRpcFinish', {
      ...startEvent,
      outcome,
      durationMs: 0,
      deliveryState: error.deliveryState,
      inflight: this.rpcResolvers.size,
    });
  }

  private safeObserve(
    method: keyof KinopioObserver,
    event:
      | ConnectionStateEvent
      | RpcStartEvent
      | RpcFinishEvent
      | LateReplyEvent,
  ): void {
    const callback = this.observer?.[method] as
      | ((observerEvent: any) => void)
      | undefined;
    if (!callback) {
      return;
    }
    try {
      callback(event);
    } catch (_) {
      this.observerErrors += 1;
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (state === this.connectionState) {
      return;
    }
    const previous = this.connectionState;
    this.connectionState = state;
    this.safeObserve('onConnectionStateChange', { previous, current: state });
  }

  private elapsedMs(startedAt: [number, number]): number {
    const elapsed = process.hrtime(startedAt);
    return elapsed[0] * 1000 + elapsed[1] / 1e6;
  }

  private handleTransportFailure(
    message: string,
    expectedConnection: amqp.ChannelModel | undefined = this.connection,
    expectedChannel: amqp.Channel | undefined = this.channel,
  ): void {
    if (this.closing) {
      return;
    }
    if (
      (expectedConnection !== undefined &&
        expectedConnection !== this.connection) ||
      (expectedChannel !== undefined && expectedChannel !== this.channel)
    ) {
      return;
    }
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    this.replyConsumerReady = false;
    this.readyEventConsumers = 0;
    this.lastDisconnectedAt = Date.now();
    this.rejectAllPending(
      () => new RpcConnectionLostError(message),
      'connection_lost',
    );
    this.setConnectionState('disconnected');
    void this.retireTransport(channel, connection);
    this.reestablishConnection();
  }

  private async retireTransport(
    channel?: amqp.Channel,
    connection?: amqp.ChannelModel,
  ): Promise<void> {
    if (channel) {
      try {
        await channel.close();
      } catch (_) {
        // The channel may already have been closed by the broker.
      }
    }
    if (connection) {
      try {
        await connection.close();
      } catch (_) {
        // The connection may already have been closed by the broker.
      }
    }
  }

  // tslint:disable-next-line:member-ordering
  protected reestablishConnection() {
    if (this.reconnectLock || this.closing) {
      return;
    }
    this.reconnectLock = true;
    this.setConnectionState('reconnecting');
    this.logger(
      `connection closed, try to connect in ${
        this.reconnectInterval / 1000
      } seconds`,
    );
    this.reconnectTimer = setTimeout(this.reconnect, this.reconnectInterval);
  }

  // tslint:disable-next-line:member-ordering
  protected reconnect = async () => {
    this.reconnectTimer = undefined;
    if (this.closing) {
      return;
    }
    this.logger(
      `trying to reconnect to amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`,
    );
    this.numAttempts += 1;
    const timeout =
      this.reconnectInterval + this.numAttempts * this.reconnectInterval;
    try {
      await this.connect();
      this.reconnectLock = false;
    } catch (error) {
      if (this.numAttempts === this.reconnectMaxAttemptes) {
        this.logger(
          `failed to reconnect after ${this.reconnectMaxAttemptes} tries`,
        );
        this.reconnectLock = false;
        this.setConnectionState('disconnected');
        return;
      }
      this.logger(
        `could not connect, trying again in ${timeout / 1000} seconds`,
      );
      this.setConnectionState('reconnecting');
      this.reconnectTimer = setTimeout(this.reconnect, timeout);
    }
  };
}
