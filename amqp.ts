import { Kinopio, EventHandlerType } from "./dist";

const hostname = 'localhost';
const port = 5672;
const vhost = '/';
const username = 'guest';
const password = 'guest';
// const namekoWorkerCtx = {
//   'nameko.authorization': 'testAuthorization',
//   'nameko.language': 'en-us',
//   'nameko.locale': 'en-us',
// };

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const kinopio = new Kinopio('testGateway', {
  hostname,
  port,
  vhost,
  username,
  password,
  // logger: () => {},
  // requestLogger: () => {},
  // responseLogger: () => {},
});

export interface RpcEventHandlerMethodInfo {
  sourceService: string;
  eventType: string;
  handlerType: EventHandlerType;
  reliableDelivery: boolean;
  requeueOnError: boolean;
  handlerName: any;
  handlerFunction: any;
}

// const rpcEventHandlerMethod = (
//   sourceService: string,
//   eventType: string,
//   handlerType: EventHandlerType = EventHandlerType.SERVICE_POOL,
//   reliableDelivery: boolean = true,
//   requeueOnError: boolean = false,
// ): MethodDecorator => {
//   return (target, propertyKey: string | symbol, descriptor): any => {
//     const originalFunc = descriptor.value;
//     if (!Reflect.has(target, 'rpcEventHandlerMethods')) {
//       Reflect.set(target, 'rpcEventHandlerMethods', []);
//     }
//     const rpcEventHandlerMethods: RpcEventHandlerMethodInfo[] = Reflect.get(
//       target,
//       'rpcEventHandlerMethods',
//     );
//     rpcEventHandlerMethods.push({
//       sourceService,
//       eventType,
//       handlerType,
//       reliableDelivery,
//       requeueOnError,
//       handlerName: propertyKey.toString(),
//       handlerFunction: originalFunc,
//     });
//     Reflect.set(target, 'rpcEventHandlerMethods', rpcEventHandlerMethods);
//   };
// };

// function eventHandlerClasslogClass<T extends new (...args: any[]) => {}>(
//   constructor: T,
// ) {
//   return class extends constructor {
//     constructor(...args: any[]) {
//       super(...args);
//       if (!Reflect.has(this, 'rpcEventHandlerMethods')) {
//         return;
//       }
//       const rpcEventHandlerMethods: RpcEventHandlerMethodInfo[] = Reflect.get(
//         this,
//         'rpcEventHandlerMethods',
//       );
//       rpcEventHandlerMethods.forEach((methods: RpcEventHandlerMethodInfo) => {
//         kinopio.createEventHandler({
//           target: this,
//           ...methods,
//         });
//       });
//     }
//   };
// }

async function test() {
  @kinopio.eventHandlerClasslogClass
  class A {
    name: string;
    constructor() {
      this.name = 'aa';
    }
    @kinopio.rpcEventHandlerMethod('properties', 'property_updated')
    public eventHandlerFunc(message: string) {
      try {
        console.log('this: ', this.name);
        console.log('messageContent: ', message);
        this.getCity();
      } catch (error) {
        console.log('error: ', error);
      }
    }
    private getCity() {
      console.log('getCity: ', this);
    }
  }

  await sleep(100);
  await kinopio.connect();
  // const rpc = await kinopio.buildRpcProxy(namekoWorkerCtx);

  const a = new A();
  a.eventHandlerFunc('asd');
  // const eventHandlers: EventHandlerDefinition[] = Reflect.get(
  //   A,
  //   'eventHandlers',
  //   [],
  // );
  // eventHandlers.forEach((e) => {
  //   kinopio.createEventHandler(
  //     e.sourceService,
  //     e.eventType,
  //     e.handlerType,
  //     e.methodName,
  //     a.eventHandlerFunc.bind(a),
  //     e.reliableDelivery,
  //     e.requeueOnError,
  //   );
  // });
  await sleep(100);
  // rpc.properties.ping();
  // rpc.tests.ping()
  // rpc.tests.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // rpc.files.ping()
  // kinopio.close()
  // while (true) {
  //   rpc.files.ping()
  //   await sleep(100)
  // }
}

test();
