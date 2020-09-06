import { Kinopio, EventHandlerType } from './dist';

const hostname = 'localhost';
const port = 5672;
const vhost = '/';
const username = 'guest';
const password = 'guest';
const namekoWorkerCtx = {
  'nameko.authorization': 'testAuthorization',
  'nameko.language': 'en-us',
  'nameko.locale': 'en-us',
  'nameko.bbb': "asddsa"
};

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
  const rpc = await kinopio.buildRpcProxy(namekoWorkerCtx);

  const a = new A();
  a.eventHandlerFunc('asd');

  await sleep(100);
  // rpc.properties.ping();
  await rpc.tests.ping();
  rpc.dispatch('hahaha', { ha: true });
  // await sleep(100);
  // kinopio.close()
}

test();
