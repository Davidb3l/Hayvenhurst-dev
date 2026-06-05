# Fixture for the imports test. Exercises both file-level imports
# (which should anchor against the synthetic module node) and
# function-nested imports (which should anchor against the function).

import os
from typing import List


def helper():
    # Function-nested import — the edge's src_name should be `helper`,
    # not the module name. The daemon uses this to scope the edge.
    import json
    return json.dumps([])
