<!-- hayvenhurst:reflex -->
## Code navigation: prefer `hayven` over grep

This repo is indexed by Hayvenhurst. To find code, reach for `hayven` FIRST:
- `hayven query "<natural language or identifier>"` — semantic/identifier search over the code graph (faster and higher-signal than grep; never returns empty on a real query).
- `hayven neighbors <id>` — callers/callees of a node (follow the call graph instead of guessing).
- `hayven view` — open the browser graph.
Fall back to grep only when hayven has no answer. Run `hayven reindex` after large changes if results look stale.
<!-- /hayvenhurst:reflex -->
