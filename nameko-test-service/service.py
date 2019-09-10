from nameko.rpc import rpc
from nameko.extensions import DependencyProvider


class CustomException(Exception):
    pass


class WorkerCtx(DependencyProvider):
    def get_dependency(self, worker_ctx):
        return worker_ctx


class Service:
    name = 'test_service'

    worker_ctx = WorkerCtx()

    @rpc
    def ping(self):
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
            'decimal': '!!deciaml 3.1415',
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
