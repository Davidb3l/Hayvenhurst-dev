---
name: Native binary issue
about: Problem with the hayven-native companion binary (parse, watch, or serialize).
title: "[native] "
labels: native-binary
assignees: ''
---

<!--
`hayven-native` is the Rust companion binary that handles Tree-sitter parsing,
OS-level file watching, and CRDT wire serialization. If the daemon refuses to
start because the companion is missing, signature-invalid, or crashing on
launch, this is the right template.
-->

## Environment

- **`hayven-native --version`** output:
- **Platform** (`uname -a` on Unix, `systeminfo` on Windows):
- **Install method**: pre-built release tarball / built from source (`cargo build --release`)
- **If built from source**, paste the `rustc --version` output:

## What `hayven doctor` reports

Run `hayven doctor` and paste the exact output:

```
<paste output here>
```

## What you were doing

Was the daemon starting up, running an ingest, syncing with a peer, or
something else? Be specific.

## Exact error

The full error message, including any stack trace.

```
<paste error here>
```

## Crash log (if applicable)

If a crash log was written to `.hayven/crashes/<crash-id>.json`, attach it
or paste its contents. The log contains no data outside your project root,
but please redact anything you would not want public.
