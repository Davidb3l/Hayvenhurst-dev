---
name: Bug report
about: Something is broken in the Hayvenhurst daemon, CLI, or viewer.
title: "[bug] "
labels: bug
assignees: ''
---

<!--
Thanks for taking the time to file a bug. The more concrete detail you can
give us, the faster we can reproduce it. If you are reporting a crash, please
also attach the crash log from `.hayven/crashes/<crash-id>.json` if one was
created.
-->

## Environment

- **Hayvenhurst version** (`hayven --version`):
- **OS + architecture** (`uname -a` on Unix, `systeminfo` on Windows):
- **How you installed** (release tarball / built from source / other):

## What happened

A clear and concise description of the bug.

## Steps to reproduce

1.
2.
3.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include exact error messages where possible.

## Daemon logs

Relevant lines from `~/.hayven/logs/daemon.log`. Trim to the lines around the
failure; please do not paste megabytes.

```
<paste logs here>
```

## Additional context

Screenshots, related issues, anything else you think might help.
