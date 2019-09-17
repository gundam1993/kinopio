import * as amqp from 'amqplib';
export declare class RpcError extends Error {
    code: string;
    remoteArgs: string[];
    remoteName: string;
    remoteFullName: string;
    constructor(message: string, remoteArgs?: string[], remoteName?: string, remoteFullName?: string);
}
export interface RpcPayload {
    args?: any[];
    kwargs?: object;
}
export declare type rpcMethod<T = any> = (payload?: RpcPayload) => Promise<T>;
export interface ServiceBase {
    [key: string]: rpcMethod | any;
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
export declare class Kinopio {
    private mqOptions;
    private connection;
    private channel;
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
    constructor(config: KinopioConfig);
    connect(): Promise<RpcContext>;
    close(): Promise<void>;
    buildRpcProxy: (workerCtx?: {}) => any;
    protected callRpc: (serviceName: string, functionName: string, payload?: RpcPayload, workerCtx?: object) => Promise<unknown>;
    protected consumeQueue: (message: any) => void;
    protected connectMq: () => Promise<void>;
    protected reestablishConnection(): void;
    protected reconnect: () => Promise<void>;
}
export {};
