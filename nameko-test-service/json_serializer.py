from decimal import Decimal

import orjson


def encode_value(value):
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError("{} is not JSON serialisable".format(repr(value)))


def encode(value):
    return orjson.dumps(value, default=encode_value)


def decode(value):
    return orjson.loads(value)
