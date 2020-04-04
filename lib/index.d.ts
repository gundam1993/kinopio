import * as amqp from 'amqplib';
import "reflect-metadata";
export declare enum EventHandlerType {
    SERVICE_POOL = 0,
    SINGLETON = 1,
    BROADCAST = 2
}
export declare class RpcError extends Error {
    code: string;
    remoteArgs?: string[];
    remoteName?: string;
    remoteFullName?: string;
    constructor(message: string, remoteArgs?: string[], remoteName?: string, remoteFullName?: string);
}
export interface RpcPayload {
    args?: any[];
    kwargs?: object;
}
export declare type RpcMethod<T = any> = (payload?: RpcPayload) => Promise<T>;
export interface ServiceBase {
    [key: string]: RpcMethod | any;
}
interface RpcContextBase {
    workerCtx: any;
    [key: string]: ServiceBase | any;
}
export declare type RpcContext<T = any> = T & RpcContextBase;
export interface KinopioConfig {
    hostname?: string;
    port?: number;
    vhost?: string;
    username?: string;
    password?: string;
    onRequest?: (serviceName: string, functionName: string, rpcPayload: object) => void;
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
export interface EventHandlerDefinition {
    sourceService: string;
    eventType: string;
    handlerType: EventHandlerType;
    reliableDelivery: boolean;
    requeueOnError: boolean;
    methodName: string | symbol;
}
export declare class Kinopio {
    private serviceName;
    private mqOptions;
    private connection;
    private channel;
    private eventChannels;
    private entrypointHooks;
    private queuePrefix;
    private rpcResolvers;
    private replyToId;
    private logger;
    private requestLogger;
    private responseLogger;
    private reconnectLock;
    private userCallbackOnConnect;
    private reconnectInterval;
    private reconnectMaxAttemptes;
    private numAttempts;
    static eventHandlers: amqp.Channel[];
    constructor(serviceName: string, config: KinopioConfig);
    connect(): Promise<RpcContext>;
    close(): Promise<void>;
    buildRpcProxy: (workerCtx?: {}) => any;
    rpcEventHandler: (sourceService: string, eventType: string, handlerType?: EventHandlerType, reliableDelivery?: boolean, requeueOnError?: boolean) => MethodDecorator;
    createEventHandler: (sourceService: string, eventType: string, handlerType: EventHandlerType, handlerName: string | symbol, handlerFunction: (msg: any) => any, reliableDelivery: boolean, requeueOnError: boolean) => Promise<void>;
    protected callRpc: (serviceName: string, functionName: string, payload?: RpcPayload, workerCtx?: any) => Promise<unknown>;
    protected consumeQueue: (message: any) => void;
    protected connectMq: () => Promise<void>;
    protected parseMessage(message: any): any;
    protected reestablishConnection(): void;
    protected reconnect: () => Promise<void>;
}
export {};
