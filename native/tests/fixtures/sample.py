"""Tiny fixture used by parse_python integration tests."""

import os
from typing import List


def greet(name):
    return f"hello {name}"


class Greeter:
    def hello(self, name):
        return greet(name)

    def shout(self, name):
        return self.hello(name).upper()


def main():
    g = Greeter()
    return g.shout("world")
