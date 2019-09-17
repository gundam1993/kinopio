"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
var uuid = require("uuid/v4");
var amqp = require("amqplib");
var RpcError = /** @class */ (function (_super) {
    __extends(RpcError, _super);
    function RpcError(message, remoteArgs, remoteName, remoteFullName) {
        var _this = _super.call(this, message) || this;
        _this.code = 'RPC_REMOTE_ERROR';
        _this.name = _this.constructor.name;
        _this.remoteArgs = remoteArgs;
        _this.remoteName = remoteName;
        _this.remoteFullName = remoteFullName;
        return _this;
    }
    return RpcError;
}(Error));
exports.RpcError = RpcError;
function parseXJson(_, value) {
    if (typeof value === 'string') {
        var stringableMatches = value.match(/^\!\!(datetime|date|deciaml) (.*)/);
        var parsedValue = value;
        if (stringableMatches && stringableMatches.length === 3) {
            parsedValue = stringableMatches[2];
        }
        return parsedValue;
    }
    return value;
}
var Kinopio = /** @class */ (function () {
    function Kinopio(config) {
        var _this = this;
        this.rpcResolvers = {};
        this.reconnectLock = false;
        this.numAttempts = 0;
        this.buildRpcProxy = function (workerCtx) {
            if (workerCtx === void 0) { workerCtx = {}; }
            return new Proxy({ workerCtx: workerCtx }, {
                get: function (target, serviceName) {
                    if (serviceName === 'workerCtx') {
                        return target.workerCtx;
                    }
                    return new Proxy({ serviceName: serviceName }, {
                        get: function (serviceTarget, functionName) {
                            return function (payload) {
                                return _this.callRpc(serviceTarget.serviceName.toString(), functionName.toString(), payload, target.workerCtx);
                            };
                        }
                    });
                }
            });
        };
        this.callRpc = function (serviceName, functionName, payload, workerCtx) {
            if (payload === void 0) { payload = {}; }
            if (workerCtx === void 0) { workerCtx = {}; }
            return __awaiter(_this, void 0, void 0, function () {
                var routingKey, correlationId;
                var _this = this;
                return __generator(this, function (_a) {
                    routingKey = serviceName + "." + functionName;
                    correlationId = uuid();
                    return [2 /*return*/, new Promise(function (resolve, reject) {
                            _this.rpcResolvers[correlationId] = { resolve: resolve, reject: reject };
                            var _a = payload.args, args = _a === void 0 ? [] : _a, _b = payload.kwargs, kwargs = _b === void 0 ? {} : _b;
                            var rpcPayload = { args: args, kwargs: kwargs };
                            _this.entrypointHooks.onRequest &&
                                _this.entrypointHooks.onRequest(serviceName, functionName, rpcPayload);
                            _this.requestLogger('%s: %s() payload: %o', correlationId, routingKey, rpcPayload);
                            _this.requestLogger('workerCtx: %o', workerCtx);
                            _this.channel.publish('nameko-rpc', routingKey, new Buffer(JSON.stringify(rpcPayload)), {
                                correlationId: correlationId,
                                replyTo: _this.replyToId,
                                headers: workerCtx,
                                contentEncoding: 'utf-8',
                                contentType: 'application/xjson',
                                deliveryMode: 2,
                                priority: 0
                            });
                        })];
                });
            });
        };
        this.consumeQueue = function (message) {
            var correlationId = message.properties.correlationId;
            if (correlationId in _this.rpcResolvers) {
                var rawMessageContent = message.content.toString();
                var messageContent = JSON.parse(rawMessageContent, parseXJson);
                var resolver = _this.rpcResolvers[correlationId];
                _this.rpcResolvers[correlationId] = undefined;
                _this.responseLogger('%s: payload: %o', correlationId, messageContent);
                if (messageContent.error) {
                    resolver.reject(new RpcError(messageContent.error.value, messageContent.error.exc_args, messageContent.error.exc_type, messageContent.error.exc_path));
                }
                else {
                    if (_this.entrypointHooks.processResponse) {
                        messageContent.result = _this.entrypointHooks.processResponse(messageContent.result);
                    }
                    _this.entrypointHooks.onResponse &&
                        _this.entrypointHooks.onResponse(messageContent.result);
                    resolver.resolve(messageContent.result);
                }
            }
        };
        this.connectMq = function () { return __awaiter(_this, void 0, void 0, function () {
            var _a, _b, queueName, queueInfo;
            var _this = this;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _a = this;
                        return [4 /*yield*/, amqp.connect(this.mqOptions)];
                    case 1:
                        _a.connection = _c.sent();
                        this.connection.on('close', function () {
                            _this.logger('connection close');
                            _this.reestablishConnection();
                        });
                        this.connection.on('error', function () {
                            _this.logger('connection error');
                            _this.reestablishConnection();
                        });
                        _b = this;
                        return [4 /*yield*/, this.connection.createChannel()];
                    case 2:
                        _b.channel = _c.sent();
                        this.channel.on('close', function () {
                            _this.logger('channel close');
                            _this.reestablishConnection();
                        });
                        this.channel.on('error', function () {
                            _this.logger('channel error');
                            _this.reestablishConnection();
                        });
                        this.logger("connected to amqp server: amqp://" + this.mqOptions.hostname + ":" + this.mqOptions.port + "/" + this.mqOptions.vhost);
                        queueName = this.queuePrefix + "-" + this.replyToId;
                        return [4 /*yield*/, this.channel.assertQueue(queueName, {
                                exclusive: true,
                                autoDelete: true,
                                durable: false
                            })];
                    case 3:
                        queueInfo = _c.sent();
                        return [4 /*yield*/, this.channel.bindQueue(queueInfo.queue, 'nameko-rpc', this.replyToId)];
                    case 4:
                        _c.sent();
                        return [4 /*yield*/, this.channel.consume(queueInfo.queue, this.consumeQueue, {
                                noAck: true
                            })];
                    case 5:
                        _c.sent();
                        this.numAttempts = 0;
                        return [4 /*yield*/, this.userCallbackOnConnect(this.connection, this.channel)];
                    case 6:
                        _c.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.reconnect = function () { return __awaiter(_this, void 0, void 0, function () {
            var timeout, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.logger("trying to reconnect to amqp://" + this.mqOptions.hostname + ":" + this.mqOptions.port + "/" + this.mqOptions.vhost);
                        this.numAttempts += 1;
                        timeout = this.reconnectInterval + this.numAttempts * this.reconnectInterval;
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.connectMq()];
                    case 2:
                        _a.sent();
                        this.reconnectLock = false;
                        return [3 /*break*/, 4];
                    case 3:
                        error_1 = _a.sent();
                        if (this.numAttempts === this.reconnectMaxAttemptes) {
                            this.logger("failed to reconnect after " + this.reconnectMaxAttemptes + " tries");
                            throw new Error("AMQP disconnected after " + this.reconnectMaxAttemptes + " attempts");
                        }
                        this.logger("could not connect, trying again in " + timeout / 1000 + " seconds");
                        setTimeout(this.reconnect, this.reconnectInterval);
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        }); };
        if (!config)
            throw new Error('Kinopio requires options.');
        var hostname = config.hostname, port = config.port, vhost = config.vhost, username = config.username, password = config.password, onRequest = config.onRequest, onResponse = config.onResponse, processResponse = config.processResponse, queuePrefix = config.queuePrefix, _a = config.logger, logger = _a === void 0 ? console.log : _a, requestLogger = config.requestLogger, responseLogger = config.responseLogger, onConnect = config.onConnect, reconnectInterval = config.reconnectInterval, reconnectMaxAttemptes = config.reconnectMaxAttemptes;
        this.mqOptions = { hostname: hostname, port: port, vhost: vhost, username: username, password: password };
        this.entrypointHooks = { onRequest: onRequest, onResponse: onResponse, processResponse: processResponse };
        this.queuePrefix = queuePrefix || 'rpc.replay';
        this.replyToId = uuid();
        this.logger = logger;
        this.requestLogger = requestLogger || this.logger;
        this.responseLogger = responseLogger || this.logger;
        this.userCallbackOnConnect = onConnect || (function () { });
        this.reconnectInterval = reconnectInterval || 2000;
        this.reconnectMaxAttemptes = reconnectMaxAttemptes || 10;
    }
    Kinopio.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.connectMq()];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Kinopio.prototype.close = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.logger('disconnectiong from smqp server...');
                        return [4 /*yield*/, this.channel.close()];
                    case 1:
                        _a.sent();
                        this.channel = undefined;
                        return [4 /*yield*/, this.connection.close()];
                    case 2:
                        _a.sent();
                        this.connection = undefined;
                        this.logger('amqp server disconnected');
                        return [2 /*return*/];
                }
            });
        });
    };
    Kinopio.prototype.reestablishConnection = function () {
        if (this.reconnectLock) {
            return;
        }
        this.reconnectLock = true;
        this.logger("connection closed, try to connect in " + this.reconnectInterval /
            1000 + " seconds");
        setTimeout(this.reconnect, this.reconnectInterval);
    };
    return Kinopio;
}());
exports.Kinopio = Kinopio;
