---
name: Performance regression
about: A specific operation got measurably slower between two Hayvenhurst versions.
title: "[perf] "
labels: performance
assignees: ''
---

<!--
Use this template only when you have measured a regression — i.e. version X
was fast, version Y is slow, and you can quantify the difference. For
"Hayvenhurst feels slow in general" please use the bug template instead.
-->

## Versions

- **Baseline version** (the fast one):
- **Regressed version** (the slow one):
- **First version where you noticed it** (if different from above):

## Repo characteristics

- **Lines of code** (`tokei`, `cloc`, or similar):
- **File count**:
- **Primary language(s)**:
- **Any unusual characteristics** (vendored deps, generated code, huge files):

## Hardware

- **Machine** (e.g. "Mac Mini M4", "ThinkPad T14 Gen 4"):
- **RAM**:
- **CPU cores**:
- **GPU** (if relevant for local inference):
- **Storage** (SSD / NVMe / HDD):

## Measurements

Wall-clock timings on the same machine, same repo, same operation.

| Operation | Baseline (vX.Y.Z) | Regressed (vA.B.C) | Delta |
|---|---|---|---|
| `hayven init` |  |  |  |
| `hayven ingest` |  |  |  |
| `hayven query "..."` |  |  |  |
| (other) |  |  |  |

## `hayven doctor --bench` output

```
<paste benchmark output here>
```

## Reproduction

Steps to reproduce on a fresh checkout if possible. If the repo is private,
describe its shape (LOC, file count, languages) accurately enough that we
can construct a similar test bed.
