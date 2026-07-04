//! Integration tests for the `hayven-native infer` subcommand (ARCHITECTURE.md
//! §18). The arg-parsing and error paths run with NO model present and are the
//! Week-8 de-risk's testable surface. The single real-inference test SKIPS
//! cleanly when a model directory is absent — mirroring the daemon test
//! suite's `findBinary()` / `describe.skip` posture (CLAUDE.md "Dev gotchas").
//! The human runs real weights on their machine.

use assert_cmd::Command;
use predicates::str::contains;

/// Env var pointing at a real model directory (containing `model.gguf` +
/// `tokenizer.json`). When unset, the real-inference test is skipped — it is
/// NOT a failure, exactly like the daemon's `findBinary()` skip.
const MODEL_DIR_ENV: &str = "HAYVEN_TEST_MODEL_DIR";

#[test]
fn infer_emits_version_handshake_on_stderr() {
    // §16.4: every subcommand emits a version record. For infer, stdout is
    // reserved for the completion, so the handshake goes to stderr. We hit an
    // error path (nonexistent model) so no weights are needed; the version
    // line must still be present on stderr as the first line.
    let out = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["infer", "--model", "/nonexistent-hayven-model"])
        .write_stdin("hi")
        .assert()
        .failure()
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&out.stderr);
    let first = stderr.lines().next().expect("stderr non-empty");
    let parsed: serde_json::Value =
        serde_json::from_str(first).expect("first stderr line is the version record JSON");
    assert_eq!(parsed["type"], "version");
    assert_eq!(parsed["protocol"], 2);
}

#[test]
fn infer_missing_model_dir_exits_nonzero_empty_stdout() {
    // The acceptance sanity check: `echo "hi" | infer --model /nonexistent`
    // must exit non-zero with a clear stderr message and EMPTY stdout (the
    // daemon parses stdout as the completion — error noise there would
    // corrupt it).
    let out = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["infer", "--model", "/nonexistent-hayven-model"])
        .write_stdin("hi")
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(contains("not accessible"))
        .get_output()
        .clone();
    assert!(out.stdout.is_empty(), "stdout must be empty on error");
}

#[test]
fn infer_model_path_is_a_file_not_dir_errors() {
    // `--model` must be a DIRECTORY. Pointing it at a regular file is a clear,
    // non-zero-exit error with empty stdout.
    let file = tempfile::NamedTempFile::new().expect("tempfile");
    Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["infer", "--model", file.path().to_str().unwrap()])
        .write_stdin("hi")
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(contains("must be a directory"));
}

#[test]
fn infer_dir_missing_gguf_errors() {
    // An existing but empty directory: the missing `model.gguf` is reported.
    let dir = tempfile::tempdir().expect("tempdir");
    Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["infer", "--model", dir.path().to_str().unwrap()])
        .write_stdin("hi")
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .stderr(contains("model.gguf"));
}

#[test]
fn infer_dir_missing_tokenizer_is_not_an_error_at_resolve() {
    // BL-14: GGUF present, NO tokenizer.json. This must NO LONGER fail at the
    // artifact-resolution step (the tokenizer is rebuilt from the GGUF). With
    // a fake/garbage GGUF the run still fails — but LATER, at the GGUF header
    // read — and the failure must NOT be the old "tokenizer.json not found"
    // message, and stdout must stay empty.
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("model.gguf"), b"\0not-a-real-gguf").expect("write gguf");
    let out = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["infer", "--model", dir.path().to_str().unwrap()])
        .write_stdin("hi")
        .assert()
        .failure()
        .stdout(predicates::str::is_empty())
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.contains("tokenizer not found"),
        "no-sidecar must not error as a missing-tokenizer; got: {stderr}"
    );
    // It should have progressed to reading the GGUF (which is garbage here).
    assert!(
        stderr.contains("GGUF") || stderr.contains("gguf"),
        "expected a GGUF-read failure, got: {stderr}"
    );
}

#[test]
fn infer_corrupt_gguf_load_failure_errors() {
    // Both files present but the GGUF is garbage: candle's loader must fail
    // cleanly — non-zero exit, empty stdout, message on stderr. This exercises
    // the "GGUF load failure" branch of the contract without real weights.
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("model.gguf"), b"not a gguf file at all").expect("gguf");
    // A minimal-but-parseable tokenizer so we get past the tokenizer load and
    // actually reach the GGUF read. An empty WordLevel model is enough.
    let tok = r#"{"version":"1.0","truncation":null,"padding":null,"added_tokens":[],"normalizer":null,"pre_tokenizer":null,"post_processor":null,"decoder":null,"model":{"type":"WordLevel","vocab":{"a":0},"unk_token":"a"}}"#;
    std::fs::write(dir.path().join("tokenizer.json"), tok).expect("tokenizer");
    Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["infer", "--model", dir.path().to_str().unwrap()])
        .write_stdin("hi")
        .assert()
        .failure()
        .stdout(predicates::str::is_empty());
}

#[test]
fn infer_real_weights_generate_completion() {
    // Real-inference test. SKIPS cleanly when HAYVEN_TEST_MODEL_DIR is unset
    // (sandbox reality — no multi-GB weights here), mirroring the daemon's
    // `findBinary()`/`describe.skip`. The human sets the env var to a dir with
    // `model.gguf` + `tokenizer.json` to run it for real.
    let Ok(model_dir) = std::env::var(MODEL_DIR_ENV) else {
        eprintln!("skipping infer_real_weights_generate_completion: {MODEL_DIR_ENV} unset");
        return;
    };

    // Greedy (temp 0) ⇒ deterministic. Two runs of the same prompt must match.
    let run = || {
        Command::cargo_bin("hayven-native")
            .expect("locate built binary")
            .args([
                "infer",
                "--model",
                &model_dir,
                "--max-tokens",
                "16",
                "--temp",
                "0.0",
            ])
            .write_stdin("Reply with the single word: ping")
            .assert()
            .success()
            .get_output()
            .stdout
            .clone()
    };

    let first = run();
    let second = run();
    // BL-18 root regression: before the chat-template + tokenizer fix, a Gemma
    // instruct model fed the malformed prompt emitted `<end_of_turn>` as its
    // first token and produced ZERO output (empty stdout, exit 0). A non-empty
    // completion is the load-bearing assertion.
    assert!(!first.is_empty(), "completion stdout must be non-empty");
    assert_eq!(
        first, second,
        "greedy (temp 0) decoding must be deterministic across runs"
    );
}

#[test]
fn infer_real_weights_conflict_prompt_yields_yes_no_verdict() {
    // BL-18 end-to-end: the §7.3 conflict-preview prompt (the exact shape the
    // daemon's LlmOracle builds) must produce a completion that BEGINS with a
    // recognizable YES/NO — that is what `parseVerdict` keys on to return a
    // calibrated LLM verdict instead of falling back to the heuristic. SKIPS
    // cleanly when HAYVEN_TEST_MODEL_DIR is unset.
    let Ok(model_dir) = std::env::var(MODEL_DIR_ENV) else {
        eprintln!(
            "skipping infer_real_weights_conflict_prompt_yields_yes_no_verdict: {MODEL_DIR_ENV} unset"
        );
        return;
    };

    // Mirrors daemon/src/conflict/llm_oracle.ts::buildPrompt for a CONFLICTING
    // pair (rename a function vs. edit one of its callers).
    let prompt = "\
You are reviewing two concurrent code-change claims on one codebase.

Claim A (already active):
  intent: rename the authenticate() function to verifyCredentials() and update all callers
  scope: auth/login.ts:authenticate
  graph neighbors: auth/session.ts:createSession, api/routes.ts:loginHandler

My intended work:
  intent: add rate-limiting to the login endpoint
  scope: api/routes.ts:loginHandler
  graph neighbors: auth/login.ts:authenticate

Read claim A and my intended work — is there a plausible way our edits break each other's assumptions or produce inconsistent state? Begin your reply with the single word YES or NO, then give one sentence of justification.";

    let output = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args([
            "infer",
            "--model",
            &model_dir,
            "--max-tokens",
            "64",
            "--temp",
            "0.0",
        ])
        .write_stdin(prompt)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();

    let completion = String::from_utf8(output).expect("utf-8 completion");
    assert!(
        !completion.is_empty(),
        "verdict completion must be non-empty"
    );
    // parseVerdict's contract: the FIRST yes/no word-boundary token wins. Assert
    // such a token exists so the oracle gets a real verdict (not the fallback).
    let lower = completion.to_lowercase();
    let has_verdict = lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .any(|w| w == "yes" || w == "no");
    assert!(
        has_verdict,
        "conflict prompt completion must contain a YES/NO token parseVerdict can read; got: {completion:?}"
    );
}
