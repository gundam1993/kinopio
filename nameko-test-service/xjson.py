import ast
import json
import re
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from functools import singledispatch

from dateutil.parser import parse as parse_date
import udatetime


class Type(Enum):

    datetime = "datetime"
    date = "date"
    decimal = "decimal"
    set = "set"

    @property
    def tag(self):
        return "!!{}".format(self.value)

    def tagged(self, value):
        return "{} {}".format(self.tag, value)


@singledispatch
def encode_value(value):
    raise TypeError("{} is not JSON serialisable".format(repr(value)))


@encode_value.register(datetime)
def encode_datetime(value):
    return Type.datetime.tagged(value.isoformat())


@encode_value.register(date)
def encode_date(value):
    return Type.date.tagged(value.isoformat())


@encode_value.register(Decimal)
def encode_decimal(value):
    return Type.decimal.tagged(value)


@encode_value.register(set)
def encode_set(value):
    return Type.set.tagged(value)


tag_pattern = "^\!\!({}) (.*)".format(
    "|".join(type_.value for type_ in Type.__members__.values())
)
tag_parser = re.compile(tag_pattern)


parsers = {
    Type.datetime: lambda value: udatetime.from_string(value),
    Type.date: lambda value: parse_date(value).date(),
    Type.decimal: lambda value: Decimal(value),
    Type.set: (lambda value: set() if value == "set()" else ast.literal_eval(value)),
}


def object_hook(obj):
    for key, value in obj.items():
        try:
            tagged = tag_parser.match(value)
        except TypeError:
            pass
        else:
            if tagged:
                type_, value = tagged.groups()
                obj[key] = parsers[Type(type_)](value)
    return obj


def encode(value):
    return json.dumps(value, default=encode_value)


def decode(value):
    return json.loads(value, object_hook=object_hook)


dumps = encode
loads = decode
