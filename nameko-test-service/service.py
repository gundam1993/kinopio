from nameko.rpc import rpc
from nameko.events import EventDispatcher, event_handler
from nameko.extensions import DependencyProvider
import time


class CustomException(Exception):
    pass


class WorkerCtx(DependencyProvider):
    def get_dependency(self, worker_ctx):
        return worker_ctx


class Service:
    name = 'tests'

    worker_ctx = WorkerCtx()
    event_dispatcher = EventDispatcher()

    @rpc
    def ping(self):
        print('ping')
        self.event_dispatcher("ping_pong", {
            "info": "ping-pong!"
        })
        return 'pong'

    @rpc
    def repeat(self, *args, **kwargs):
        return {
            'args': args,
            'kwargs': kwargs
        }

    @rpc
    def get_some_data(self):
        return {
            'int': 1,
            'float': 0.01,
            'string': 'foo',
            'boolean': True,
            'array': [1, 2, 3],
            'object': {'key': 'value'}
        }

    @rpc
    def get_some_xjson_data(self):
        return {
            'datetime': '!!datetime 2018-01-01T01:01:01',
            'date': '!!date 2018-05-29',
            'decimal': '!!decimal 3.1415',
            'int': 1,
            'float': 0.01,
            'string': 'foo',
            'boolean': True,
            'array': [1, 2, 3],
            'object': {'key': 'value'}
        }

    @rpc
    def raise_noraml_exception(self):
        raise Exception('normal exception')

    @rpc
    def raise_custom_exception(self):
        raise CustomException('custom exception')

    @rpc
    def return_worker_ctx(self):
        return self.worker_ctx.data

    @event_handler('testGateway', 'hahaha')
    def handle_hahaha(self, payload):
        print('payload: ', payload)
        
