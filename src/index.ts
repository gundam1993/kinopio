import * as debug from 'debug';
import * as uuid from 'uuid/v4';
import * as amqp from 'amqplib';
import { connect } from './connection';

interface EntrypointsHooks {
  processResponse?: (response: any) => any;
  onResponse?: (response: any) => void;
  onRequest?: (
    serviceName: string,
    functionName: string,
    rpcPayload: object
  ) => void;
}

const log = debug('nameko-rpc');
const logRequest = debug('nameko-rpc:request');
const logResponse = debug('nameko-rpc:response');
const rpcResolvers = {};
const replyToId = uuid();
const entrypointHooks: EntrypointsHooks = {};
let channel: amqp.Channel;
let connection: amqp.Connection;

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

function consumeQueue(message) {
  const { correlationId } = message.properties;

  if (correlationId in rpcResolvers) {
    const rawMessageContent = message.content.toString();
    const messageContent = JSON.parse(rawMessageContent, parseXJson);

    const resolver = rpcResolvers[correlationId];
    rpcResolvers[correlationId] = undefined;

    logResponse('%s: payload: %o', correlationId, messageContent);

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
      if (entrypointHooks.processResponse) {
        messageContent.result = entrypointHooks.processResponse(
          messageContent.result
        );
      }
      entrypointHooks.onResponse &&
        entrypointHooks.onResponse(messageContent.result);
      resolver.resolve(messageContent.result);
    }
  }
}

async function onConnect(
  amqpConnection: amqp.Connection,
  amqpChannel: amqp.Channel
): Promise<void> {
  connection = amqpConnection;
  channel = amqpChannel;
  const queueName = `rpc.replay-gateway-${replyToId}`;
  const queueInfo = await channel.assertQueue(queueName, {
    exclusive: true,
    autoDelete: true,
    durable: false,
  });

  await channel.bindQueue(queueInfo.queue, 'nameko-rpc', replyToId);
  await channel.consume(queueInfo.queue, consumeQueue, {
    noAck: true,
  });
}

export async function rpcSetup(hooks: EntrypointsHooks = {}) {
  entrypointHooks.onRequest = hooks.onRequest;
  entrypointHooks.onResponse = hooks.onResponse;
  entrypointHooks.processResponse = hooks.processResponse;
  
  await connect(
    {
      hostname: process.env.RABBIT_SERVER,
      port: process.env.RABBIT_PORT,
      vhost: process.env.RABBIT_VHOST,
      username: process.env.RABBIT_USER,
      password: process.env.RABBIT_PASS,
    },
    onConnect
  );
}

export async function rpcTearDown() {
  log('disconnectiong from smqp server...');
  await channel.close();
  channel = undefined;
  await connection.close();
  connection = undefined;
  log('amqp server disconnected');
}

interface RpcPayload {
  args?: any[];
  kwargs?: object;
}

async function callRpc(
  serviceName: string,
  functionName: string,
  payload: RpcPayload = {},
  workerCtx: object = {}
) {
  const routingKey = `${serviceName}.${functionName}`;
  const correlationId = uuid();

  return new Promise((resolve, reject) => {
    if (!channel) {
      throw new Error('no channel, call rpcSetup() first');
    }

    rpcResolvers[correlationId] = { resolve, reject };
    const { args = [], kwargs = {} } = payload;
    const rpcPayload = { args, kwargs };

    entrypointHooks.onRequest &&
      entrypointHooks.onRequest(serviceName, functionName, rpcPayload);

    logRequest('%s: %s() payload: %o', correlationId, routingKey, rpcPayload);
    logRequest('workerCtx: %o', workerCtx);

    channel.publish(
      'nameko-rpc',
      routingKey,
      new Buffer(JSON.stringify(rpcPayload)),
      {
        correlationId,
        replyTo: replyToId,
        headers: workerCtx,
        contentEncoding: 'utf-8',
        contentType: 'application/xjson',
        deliveryMode: 2,
        priority: 0,
      }
    );
  });
}

export type rpcMethod<T = any> = (payload?: RpcPayload) => Promise<T>

export interface ServiceBase {
  [key: string]: rpcMethod | any;
}

interface RpcContextBase {
  workerCtx: any
  [key: string]: ServiceBase | any;
}

export type RpcContext<T=any> = T & RpcContextBase

export function rpcProxy({workerCtx = {}} = {}):RpcContext {
  return new Proxy(
    {workerCtx},
    {
      get(target, serviceName) {
        if (serviceName === 'workerCtx') {
          return target.workerCtx
        }
        return new Proxy(
          {serviceName},
          {
            get(serviceTarget, functionName) {
              return payload => callRpc(
                serviceTarget.serviceName.toString(),
                functionName.toString(),
                payload,
                target.workerCtx
              )
            }
          }
        )
      }
    }
  )
}
