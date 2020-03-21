"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const uuid = require("uuid/v4");
const amqp = require("amqplib");
var EventHandlerType;
(function (EventHandlerType) {
    EventHandlerType[EventHandlerType["SERVICE_POOL"] = 0] = "SERVICE_POOL";
    EventHandlerType[EventHandlerType["SINGLETON"] = 1] = "SINGLETON";
    EventHandlerType[EventHandlerType["BROADCAST"] = 2] = "BROADCAST";
})(EventHandlerType = exports.EventHandlerType || (exports.EventHandlerType = {}));
class RpcError extends Error {
    constructor(message, remoteArgs, remoteName, remoteFullName) {
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
exports.RpcError = RpcError;
class EventHandlerConfigurationError extends Error {
    constructor(message) {
        super(message);
    }
}
function parseXJson(_, value) {
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
class Kinopio {
    constructor(serviceName = 'kinopio', config) {
        this.serviceName = 'kinopio';
        this.rpcResolvers = {};
        this.reconnectLock = false;
        this.numAttempts = 0;
        this.buildRpcProxy = (workerCtx = {}) => {
            return new Proxy({ workerCtx }, {
                get: (target, serviceName) => {
                    if (serviceName === 'workerCtx') {
                        return target.workerCtx;
                    }
                    return new Proxy({ serviceName }, {
                        get: (serviceTarget, functionName) => {
                            return payload => this.callRpc(serviceTarget.serviceName.toString(), functionName.toString(), payload, target.workerCtx);
                        },
                    });
                },
            });
        };
        this.rpcEventHandler = (sourceService, eventType, handlerType = EventHandlerType.SERVICE_POOL, reliableDelivery = true, requeueOnError = false) => {
            return (_, propertyKey, descriptor) => {
                const originalFunction = descriptor.value;
                descriptor.value = this.createEventHandler(sourceService, eventType, handlerType, propertyKey, originalFunction, reliableDelivery, requeueOnError);
            };
        };
        this.createEventHandler = async (sourceService, eventType, handlerType, handlerName, handlerFunction, reliableDelivery, requeueOnError) => {
            let exclusive = false;
            const serviceName = this.serviceName;
            let queueName;
            if (handlerType === EventHandlerType.SERVICE_POOL) {
                queueName = `evt-${sourceService}-${eventType}--${serviceName}.${handlerName}`;
            }
            else if (handlerType === EventHandlerType.SINGLETON) {
                queueName = `evt-${sourceService}-${eventType}`;
            }
            else {
                if (reliableDelivery) {
                    throw new EventHandlerConfigurationError(`You are using the default broadcast identifier 
          which is not compatible with reliable delivery.`);
                }
                queueName = `evt-${sourceService}-${eventType}--${serviceName}.${handlerName}-${uuid()}`;
            }
            console.log('queueName: ', queueName);
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
            const eventExchange = await eventChannel.assertExchange(exchangeName, 'topic', {
                durable: true,
                autoDelete: true,
            });
            const eventQueue = await eventChannel.assertQueue(queueName, {
                autoDelete,
                exclusive,
                durable: true,
            });
            await this.channel.bindQueue(eventQueue.queue, eventExchange.exchange, eventType);
            await this.channel.consume(eventQueue.queue, message => {
                const messageContent = this.parseMessage(message);
                handlerFunction(messageContent);
            }, {
                noAck: true,
            });
        };
        this.callRpc = async (serviceName, functionName, payload = {}, workerCtx = {}) => {
            const routingKey = `${serviceName}.${functionName}`;
            const correlationId = uuid();
            return new Promise((resolve, reject) => {
                this.rpcResolvers[correlationId] = { resolve, reject };
                const { args = [], kwargs = {} } = payload;
                const rpcPayload = { args, kwargs };
                this.entrypointHooks.onRequest &&
                    this.entrypointHooks.onRequest(serviceName, functionName, rpcPayload);
                this.requestLogger('%s: %s() payload: %o', correlationId, routingKey, rpcPayload);
                this.requestLogger('workerCtx: %o', workerCtx);
                this.channel.publish('nameko-rpc', routingKey, new Buffer(JSON.stringify(rpcPayload)), {
                    correlationId,
                    replyTo: this.replyToId,
                    headers: workerCtx,
                    contentEncoding: 'utf-8',
                    contentType: workerCtx['content_type'] || 'application/xjson',
                    deliveryMode: 2,
                    priority: 0,
                });
            });
        };
        this.consumeQueue = message => {
            const { correlationId } = message.properties;
            if (correlationId in this.rpcResolvers) {
                const messageContent = this.parseMessage(message);
                const resolver = this.rpcResolvers[correlationId];
                this.rpcResolvers[correlationId] = undefined;
                this.responseLogger('%s: payload: %o', correlationId, messageContent);
                if (messageContent.error) {
                    resolver.reject(new RpcError(messageContent.error.value, messageContent.error.exc_args, messageContent.error.exc_type, messageContent.error.exc_path));
                }
                else {
                    if (this.entrypointHooks.processResponse) {
                        messageContent.result = this.entrypointHooks.processResponse(messageContent.result);
                    }
                    this.entrypointHooks.onResponse &&
                        this.entrypointHooks.onResponse(messageContent.result);
                    resolver.resolve(messageContent.result);
                }
            }
        };
        this.connectMq = async () => {
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
            this.logger(`connected to amqp server: amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`);
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
        this.reconnect = async () => {
            this.logger(`trying to reconnect to amqp://${this.mqOptions.hostname}:${this.mqOptions.port}/${this.mqOptions.vhost}`);
            this.numAttempts += 1;
            const timeout = this.reconnectInterval + this.numAttempts * this.reconnectInterval;
            try {
                await this.connectMq();
                this.reconnectLock = false;
            }
            catch (error) {
                if (this.numAttempts === this.reconnectMaxAttemptes) {
                    this.logger(`failed to reconnect after ${this.reconnectMaxAttemptes} tries`);
                    throw new Error(`AMQP disconnected after ${this.reconnectMaxAttemptes} attempts`);
                }
                this.logger(`could not connect, trying again in ${timeout / 1000} seconds`);
                setTimeout(this.reconnect, this.reconnectInterval);
            }
        };
        if (!config)
            throw new Error('Kinopio requires options.');
        this.serviceName = serviceName;
        const { hostname, port, vhost, username, password, onRequest, onResponse, processResponse, queuePrefix, logger = console.log, requestLogger, responseLogger, onConnect, reconnectInterval, reconnectMaxAttemptes, } = config;
        this.mqOptions = { hostname, port, vhost, username, password };
        this.entrypointHooks = { onRequest, onResponse, processResponse };
        this.queuePrefix = queuePrefix || 'rpc.replay';
        this.replyToId = uuid();
        this.logger = logger;
        this.requestLogger = requestLogger || this.logger;
        this.responseLogger = responseLogger || this.logger;
        this.userCallbackOnConnect = onConnect || (() => { });
        this.reconnectInterval = reconnectInterval || 2000;
        this.reconnectMaxAttemptes = reconnectMaxAttemptes || 10;
        this.eventChannels = [];
    }
    async connect() {
        await this.connectMq();
    }
    async close() {
        this.logger('disconnectiong from smqp server...');
        await this.channel.close();
        this.channel = undefined;
        await this.connection.close();
        this.connection = undefined;
        this.logger('amqp server disconnected');
    }
    parseMessage(message) {
        const rawMessageContent = message.content.toString();
        const messageContent = JSON.parse(rawMessageContent, parseXJson);
        return messageContent;
    }
    reestablishConnection() {
        if (this.reconnectLock) {
            return;
        }
        this.reconnectLock = true;
        this.logger(`connection closed, try to connect in ${this.reconnectInterval /
            1000} seconds`);
        setTimeout(this.reconnect, this.reconnectInterval);
    }
}
exports.Kinopio = Kinopio;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLGdDQUFnQztBQUNoQyxnQ0FBZ0M7QUFZaEMsSUFBWSxnQkFJWDtBQUpELFdBQVksZ0JBQWdCO0lBQzFCLHVFQUFZLENBQUE7SUFDWixpRUFBUyxDQUFBO0lBQ1QsaUVBQVMsQ0FBQTtBQUNYLENBQUMsRUFKVyxnQkFBZ0IsR0FBaEIsd0JBQWdCLEtBQWhCLHdCQUFnQixRQUkzQjtBQUVELE1BQWEsUUFBUyxTQUFRLEtBQUs7SUFNakMsWUFDRSxPQUFlLEVBQ2YsVUFBcUIsRUFDckIsVUFBbUIsRUFDbkIsY0FBdUI7UUFFdkIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2YsSUFBSSxDQUFDLElBQUksR0FBRyxrQkFBa0IsQ0FBQztRQUMvQixJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDO1FBQ2xDLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO1FBQzdCLElBQUksQ0FBQyxVQUFVLEdBQUcsVUFBVSxDQUFDO1FBQzdCLElBQUksQ0FBQyxjQUFjLEdBQUcsY0FBYyxDQUFDO1FBRXJDLGdDQUFnQztRQUNoQyxNQUFNLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDbEQsQ0FBQztDQUNGO0FBdEJELDRCQXNCQztBQUVELE1BQU0sOEJBQStCLFNBQVEsS0FBSztJQUNoRCxZQUFZLE9BQU87UUFDakIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2pCLENBQUM7Q0FDRjtBQUVELFNBQVMsVUFBVSxDQUFDLENBQUMsRUFBRSxLQUFLO0lBQzFCLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFO1FBQzdCLE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLEtBQUssQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO1FBQzNFLElBQUks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