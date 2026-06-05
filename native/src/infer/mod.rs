//! `infer` subcommand: load a local quantized GGUF Gemma model with candle
//! (pure Rust, CPU by default) and generate a completion. ARCHITECTURE.md §18.
//!
//! Subprocess contract (must match the daemon's `LlmOracle`, §18.4):
//!   Invocation: `hayven-native infer --model <DIR> [--max-tokens N] [--temp T]`
//!   - `--model` is a DIRECTORY. We load `model.gguf` from it. The tokenizer
//!     is built from the GGUF's embedded `tokenizer.ggml.*` metadata (BL-14),
//!     so a model is usable with ONLY `model.gguf`. A sidecar `tokenizer.json`
//!     in the same directory is OPTIONAL: when present it is used as a
//!     byte-exact override; when absent the tokenizer is reconstructed from
//!     the GGUF (see `gguf_tokenizer` for the fidelity boundary).
//!   - The PROMPT is read from stdin to EOF (UTF-8).
//!   - On success: the generated COMPLETION text is the ONLY thing written to
//!     stdout (UTF-8), exit 0. All diagnostics/progress go to stderr.
//!   - On error: a human-readable message goes to stderr, stdout stays empty,
//!     and the process exits non-zero.
//!   - Determinism: `--temp 0.0` ⇒ greedy (argmax) decoding, so completions
//!     are stable and reproducible.
//!
//! The §16.4 version handshake is written to STDERR here (not stdout), the
//! same posture as the `serialize` subcommand, because stdout is reserved
//! for the completion bytes the daemon parses.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_transformers::generation::{LogitsProcessor, Sampling};
use candle_transformers::models::quantized_gemma3::ModelWeights;
use tokenizers::Tokenizer;

use crate::version_record;

mod gguf_tokenizer;

/// On-disk artifacts inside the `--model` directory.
///
/// `model.gguf` is the ONLY required artifact: the tokenizer is built from its
/// embedded `tokenizer.ggml.*` metadata (BL-14, see `gguf_tokenizer`). A
/// sidecar `tokenizer.json` is OPTIONAL — when present it overrides the
/// from-GGUF reconstruction with the byte-exact Hugging Face pipeline.
///
/// Reported as constants so the daemon and this binary agree on the filenames
/// without a shared schema.
pub const MODEL_GGUF_FILENAME: &str = "model.gguf";
pub const TOKENIZER_FILENAME: &str = "tokenizer.json";

/// Default sampling budget when the daemon does not pass `--max-tokens`.
pub const DEFAULT_MAX_TOKENS: usize = 64;
/// Default temperature. `0.0` ⇒ greedy/argmax decoding (deterministic).
pub const DEFAULT_TEMP: f64 = 0.0;
/// Fixed seed. Only relevant when `--temp > 0`; at `temp == 0` decoding is
/// argmax and the seed is inert, but we pin it so the *sampled* path is also
/// reproducible run-to-run.
const SEED: u64 = 299_792_458;

/// Resolved CLI options for `hayven-native infer`.
#[derive(Debug, Clone)]
pub struct InferOptions {
    /// Directory containing `model.gguf` (+ `tokenizer.json`).
    pub model_dir: PathBuf,
    /// Maximum number of new tokens to generate.
    pub max_tokens: usize,
    /// Sampling temperature; `<= 0.0` ⇒ greedy.
    pub temp: f64,
}

/// CLI entry point. Reads the prompt from stdin, runs inference, writes the
/// completion to stdout. Returns the process exit code: `0` on success,
/// non-zero on any error (with the message already on stderr and stdout left
/// empty). This signature mirrors `watch::run` / `serialize::run` so main.rs
/// can dispatch uniformly.
pub fn run(opts: InferOptions) -> i32 {
    // §16.4 handshake on stderr — stdout is reserved for the completion.
    emit_version_on_stderr();

    let mut prompt = String::new();
    if let Err(err) = std::io::stdin().read_to_string(&mut prompt) {
        eprintln!("hayven-native infer: failed to read prompt from stdin: {err:#}");
        return 1;
    }

    match generate(&opts, &prompt) {
        Ok(completion) => {
            // The completion is the ONLY thing on stdout. Write it raw (no
            // trailing newline injected) so the daemon receives exactly the
            // model's bytes.
            let stdout = std::io::stdout();
            let mut lock = stdout.lock();
            if let Err(err) = lock.write_all(completion.as_bytes()).and_then(|()| lock.flush()) {
                eprintln!("hayven-native infer: failed to write completion to stdout: {err:#}");
                return 1;
            }
            0
        }
        Err(err) => {
            // Human-readable error on stderr, empty stdout, non-zero exit.
            eprintln!("hayven-native infer: {err:#}");
            1
        }
    }
}

/// Load the model + tokenizer and run the generate loop. All failure modes
/// (missing dir/files, GGUF load failure, tokenizer failure, candle errors)
/// surface as an `Err` so the caller can keep stdout clean.
fn generate(opts: &InferOptions, prompt: &str) -> Result<String> {
    let (gguf_path, sidecar_tokenizer) = resolve_artifacts(&opts.model_dir)?;

    // CPU is the portable default (§18.1). Metal/CUDA are selected at compile
    // time via cargo features; `pick_device` reflects that.
    let device = pick_device();
    eprintln!("hayven-native infer: device = {}", device_label(&device));

    // Read the GGUF header once: its `metadata` feeds the from-GGUF tokenizer
    // and its tensors feed the weights. We reuse the same `Content` for both.
    let mut file = std::fs::File::open(&gguf_path)
        .with_context(|| format!("open GGUF weights {}", gguf_path.display()))?;
    let content = gguf_file::Content::read(&mut file)
        .map_err(|e| e.with_path(&gguf_path))
        .with_context(|| format!("read GGUF header {}", gguf_path.display()))?;

    // Architecture preflight (BL-18). candle 0.10.2's `quantized_gemma3` loads
    // ONLY Gemma 1/2/3 (its key-prefix probe is `["gemma3","gemma2","gemma",
    // "gemma-embedding"]`, falling back to `gemma3`). A Gemma-4 E-series GGUF
    // (`gemma4`/`gemma3n` arch) would otherwise fall through that fallback and
    // bail deep inside candle with the cryptic `cannot find
    // gemma3.attention.head_count in metadata`. We classify `general.architecture`
    // up front and refuse unsupported families with an actionable message,
    // BEFORE the heavy weight load — and leave the Gemma 2/3 happy path
    // untouched.
    let arch = gguf_tokenizer::arch_from_metadata(&content.metadata);
    validate_arch_loadable(&arch)?;

    let tokenizer = load_tokenizer(sidecar_tokenizer.as_deref(), &content)?;

    let mut model = ModelWeights::from_gguf(content, &mut file, &device)
        .with_context(|| format!("load Gemma weights from {}", gguf_path.display()))?;

    // Gemma instruct chat template. This is the canonical Google/Gemma turn
    // structure, byte-for-byte:
    //
    //     <bos><start_of_turn>user\n{prompt}<end_of_turn>\n<start_of_turn>model\n
    //
    // Two details here are LOAD-BEARING (BL-18) — get either wrong and a Gemma
    // *instruct* model, fed an out-of-distribution prompt, emits `<end_of_turn>`
    // as its very FIRST sampled token, so the generate loop breaks at index 0
    // and the completion is empty (the exact 0-token bug):
    //
    //   1. The leading `<bos>`. Gemma is trained with it. The from-GGUF
    //      tokenizer carries no TemplateProcessing post-processor, so
    //      `encode(_, add_special_tokens=true)` does NOT inject `<bos>` for us —
    //      we must put it in the string. (`<bos>` is a registered special token,
    //      so it encodes to its single id, 2, not as literal text.)
    //   2. NO space after `<start_of_turn>` / `<start_of_turn>model`. The real
    //      template is `<start_of_turn>user`, not `<start_of_turn> user`. A
    //      stray space mangles the role marker (`▁us er` instead of `user`) and
    //      shifts the prompt off-distribution.
    //
    // (The separate spurious-`▁`-after-`<bos>` defect — `Metaspace(Always)`
    // injecting a bogus leading space on the post-`<bos>` segment — is fixed in
    // `gguf_tokenizer.rs` by using `PrependScheme::First`.)
    //
    // The daemon's LlmOracle hands us the raw §7.3 conflict prompt as the user
    // turn; we wrap it in the model turn structure here so the model is in the
    // regime it was instruction-tuned for.
    let templated =
        format!("<bos><start_of_turn>user\n{prompt}<end_of_turn>\n<start_of_turn>model\n");

    // `add_special_tokens = true` lets the registered special tokens
    // (`<bos>`/`<start_of_turn>`/`<end_of_turn>`) embedded in the template encode
    // to their single ids; it does NOT inject a `<bos>` (no post-processor) — the
    // explicit one in the string above is the only `<bos>`.
    let encoding = tokenizer
        .encode(templated, true)
        .map_err(|e| anyhow::anyhow!("tokenize prompt: {e}"))?;
    let prompt_tokens: Vec<u32> = encoding.get_ids().to_vec();
    if prompt_tokens.is_empty() {
        bail!("prompt tokenized to zero tokens");
    }

    // Greedy when temp <= 0 (deterministic, §18.4); otherwise temperature
    // sampling with a pinned seed.
    let sampling = if opts.temp <= 0.0 {
        Sampling::ArgMax
    } else {
        Sampling::All {
            temperature: opts.temp,
        }
    };
    let mut logits_processor = LogitsProcessor::from_sampling(SEED, sampling);

    // EOS detection: Gemma marks the end of a model turn with `<end_of_turn>`;
    // `<eos>` is the raw sequence end. Either terminates generation. If the
    // vocab lacks both we simply run to `max_tokens`.
    let vocab = tokenizer.get_vocab(true);
    let eot_token = vocab.get("<end_of_turn>").copied();
    let eos_token = vocab.get("<eos>").copied();

    // Prefill: feed the whole prompt in one forward pass at position 0.
    let input = Tensor::new(prompt_tokens.as_slice(), &device)?.unsqueeze(0)?;
    let mut logits = model.forward(&input, 0)?.squeeze(0)?;
    let mut next_token = logits_processor.sample(&logits)?;

    let mut generated: Vec<u32> = Vec::with_capacity(opts.max_tokens);
    for index in 0..opts.max_tokens {
        if Some(next_token) == eot_token || Some(next_token) == eos_token {
            break;
        }
        generated.push(next_token);

        let input = Tensor::new(&[next_token], &device)?.unsqueeze(0)?;
        logits = model
            .forward(&input, prompt_tokens.len() + index)?
            .squeeze(0)?;
        next_token = logits_processor.sample(&logits)?;
    }

    // Decode the generated tokens (excluding the prompt). `skip_special_tokens`
    // keeps the completion clean of `<end_of_turn>`/`<bos>` markers.
    let completion = tokenizer
        .decode(&generated, true)
        .map_err(|e| anyhow::anyhow!("decode completion: {e}"))?;

    eprintln!(
        "hayven-native infer: generated {} tokens",
        generated.len()
    );
    Ok(completion)
}

/// Preflight: refuse a GGUF whose architecture candle's `quantized_gemma3`
/// module cannot load (BL-18). Supported: Gemma 1/2/3. The Gemma-4 E-series
/// (`gemma4`/`gemma3n`) is NOT loadable by candle-transformers 0.10.2 — its
/// quantized-Gemma module targets Gemma 3 and there is no `quantized_gemma4`
/// module in this version. We surface that as an actionable error instead of a
/// cryptic `cannot find gemma3.attention.head_count` deep in candle.
fn validate_arch_loadable(arch: &gguf_tokenizer::ModelArch) -> Result<()> {
    use gguf_tokenizer::ModelArch;
    if arch.is_loadable_by_quantized_gemma3() {
        eprintln!("hayven-native infer: model architecture = {arch:?} (loadable by quantized_gemma3)");
        return Ok(());
    }
    match arch {
        ModelArch::Gemma4(name) => bail!(
            "this GGUF declares architecture {name:?} (Gemma-4 E-series), which the bundled \
             candle quantized-Gemma loader (candle-transformers 0.10, quantized_gemma3 — targets \
             Gemma 3) cannot load. The Gemma-4 E-series needs an updated candle module \
             (a quantized_gemma4) once published. Until then, configure a Gemma 2/3 model \
             (e.g. gemma4:26b → bartowski/gemma-2-27b-it-GGUF), or wait for the candle bump. \
             The heuristic Layer C oracle is unaffected."
        ),
        ModelArch::GemmaOther(name) => bail!(
            "this GGUF declares an unrecognized Gemma architecture {name:?}; the bundled \
             quantized_gemma3 loader supports only Gemma 1/2/3. If this is a Gemma 2/3 variant, \
             file an issue; otherwise it is not supported by this build."
        ),
        ModelArch::NonGemma(name) => bail!(
            "this GGUF declares a non-Gemma architecture {name:?}; hayven-native infer only loads \
             Gemma-family quantized GGUFs (candle quantized_gemma3). Pull a Gemma model."
        ),
        // The loadable arm returned above; these are unreachable but keep the
        // match exhaustive without a catch-all that could mask a new variant.
        ModelArch::Gemma | ModelArch::Gemma2 | ModelArch::Gemma3 => Ok(()),
    }
}

/// Validate the `--model` directory and return `(gguf_path, sidecar_tokenizer)`.
///
/// `model.gguf` is REQUIRED. `tokenizer.json` is OPTIONAL (BL-14): when present
/// its path is returned as `Some` for use as a byte-exact override; when absent
/// `None` is returned and the tokenizer is later built from the GGUF metadata.
/// So a directory with ONLY `model.gguf` resolves successfully — no longer an
/// error. Distinguishes "not a directory" from "missing GGUF" so the operator
/// gets an actionable message; both remain non-zero-exit errors per the
/// contract.
fn resolve_artifacts(model_dir: &Path) -> Result<(PathBuf, Option<PathBuf>)> {
    let meta = std::fs::metadata(model_dir)
        .with_context(|| format!("--model path {} is not accessible", model_dir.display()))?;
    if !meta.is_dir() {
        bail!(
            "--model must be a directory containing {MODEL_GGUF_FILENAME} \
             (with an OPTIONAL {TOKENIZER_FILENAME}); got a non-directory: {}",
            model_dir.display()
        );
    }

    let gguf_path = model_dir.join(MODEL_GGUF_FILENAME);
    if !gguf_path.is_file() {
        bail!(
            "model weights not found: expected {} in --model dir {}",
            MODEL_GGUF_FILENAME,
            model_dir.display()
        );
    }

    // Optional sidecar override. Its absence is NOT an error: the tokenizer is
    // reconstructed from the GGUF metadata.
    let sidecar = model_dir.join(TOKENIZER_FILENAME);
    let sidecar = sidecar.is_file().then_some(sidecar);

    Ok((gguf_path, sidecar))
}

/// Load the tokenizer, preferring a sidecar `tokenizer.json` override when one
/// is present, else reconstructing it from the GGUF's embedded
/// `tokenizer.ggml.*` metadata (BL-14). The fidelity boundary of the from-GGUF
/// path is documented on `gguf_tokenizer`.
fn load_tokenizer(
    sidecar: Option<&Path>,
    content: &gguf_file::Content,
) -> Result<Tokenizer> {
    match sidecar {
        Some(path) => {
            eprintln!(
                "hayven-native infer: tokenizer source = sidecar {}",
                path.display()
            );
            Tokenizer::from_file(path)
                .map_err(|e| anyhow::anyhow!("load tokenizer {}: {e}", path.display()))
        }
        None => {
            eprintln!("hayven-native infer: tokenizer source = GGUF metadata (no sidecar)");
            gguf_tokenizer::tokenizer_from_gguf_metadata(&content.metadata)
                .context("build tokenizer from GGUF metadata (no sidecar tokenizer.json present)")
        }
    }
}

/// Select the compute device. CPU is the default; the optional `metal`/`cuda`
/// cargo features (OFF in the standard release, §18.6) flip this. If an
/// accelerator is requested but unavailable at runtime we fall back to CPU
/// rather than failing — the inference still completes deterministically.
fn pick_device() -> Device {
    #[cfg(feature = "metal")]
    {
        if let Ok(dev) = Device::new_metal(0) {
            return dev;
        }
    }
    #[cfg(feature = "cuda")]
    {
        if let Ok(dev) = Device::new_cuda(0) {
            return dev;
        }
    }
    Device::Cpu
}

fn device_label(device: &Device) -> &'static str {
    match device {
        Device::Cpu => "cpu",
        Device::Cuda(_) => "cuda",
        Device::Metal(_) => "metal",
    }
}

/// Emit the §16.4 version handshake on stderr (stdout is reserved for the
/// completion). Best-effort, mirroring `serialize`.
fn emit_version_on_stderr() {
    if let Ok(buf) = serde_json::to_string(&version_record()) {
        eprintln!("{buf}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifacts_rejects_missing_directory() {
        let err = resolve_artifacts(Path::new("/nonexistent-hayven-model-dir"))
            .expect_err("missing dir must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("not accessible"), "unexpected: {msg}");
    }

    #[test]
    fn artifacts_rejects_non_directory() {
        // A regular file is not a valid --model dir.
        let tmp = tempfile::NamedTempFile::new().expect("tempfile");
        let err = resolve_artifacts(tmp.path()).expect_err("file must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("must be a directory"), "unexpected: {msg}");
    }

    #[test]
    fn artifacts_reports_missing_gguf() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Empty dir: GGUF is the first thing checked.
        let err = resolve_artifacts(dir.path()).expect_err("missing gguf must error");
        let msg = format!("{err:#}");
        assert!(msg.contains(MODEL_GGUF_FILENAME), "unexpected: {msg}");
        assert!(msg.contains("not found"), "unexpected: {msg}");
    }

    #[test]
    fn artifacts_ok_with_gguf_only_no_sidecar() {
        // BL-14: a model dir with ONLY model.gguf must resolve successfully —
        // the missing tokenizer.json is no longer an error (it is rebuilt from
        // the GGUF metadata). The sidecar slot is `None`.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(MODEL_GGUF_FILENAME), b"\0not-a-real-gguf")
            .expect("write fake gguf");
        let (gguf, sidecar) = resolve_artifacts(dir.path()).expect("gguf-only must resolve");
        assert!(gguf.ends_with(MODEL_GGUF_FILENAME));
        assert!(sidecar.is_none(), "no sidecar ⇒ None, not an error");
    }

    #[test]
    fn artifacts_returns_sidecar_when_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(MODEL_GGUF_FILENAME), b"x").expect("gguf");
        std::fs::write(dir.path().join(TOKENIZER_FILENAME), b"{}").expect("tok");
        let (gguf, sidecar) = resolve_artifacts(dir.path()).expect("both present ok");
        assert!(gguf.ends_with(MODEL_GGUF_FILENAME));
        assert!(
            sidecar.expect("sidecar present").ends_with(TOKENIZER_FILENAME),
            "sidecar path must point at tokenizer.json"
        );
    }

    #[test]
    fn validate_arch_accepts_gemma_1_2_3() {
        use gguf_tokenizer::ModelArch;
        validate_arch_loadable(&ModelArch::Gemma).expect("gemma loadable");
        validate_arch_loadable(&ModelArch::Gemma2).expect("gemma2 loadable");
        validate_arch_loadable(&ModelArch::Gemma3).expect("gemma3 loadable");
    }

    #[test]
    fn validate_arch_rejects_gemma4_with_actionable_message() {
        use gguf_tokenizer::ModelArch;
        let err = validate_arch_loadable(&ModelArch::Gemma4("gemma4".into()))
            .expect_err("gemma4 must be refused");
        let msg = format!("{err:#}");
        assert!(msg.contains("Gemma-4"), "unexpected: {msg}");
        assert!(msg.contains("quantized_gemma3"), "unexpected: {msg}");
        // Mentions the workaround so the operator is not stuck.
        assert!(
            msg.contains("Gemma 2/3") || msg.contains("gemma-2"),
            "must point at a working alternative: {msg}"
        );
    }

    #[test]
    fn validate_arch_rejects_non_gemma() {
        use gguf_tokenizer::ModelArch;
        let err = validate_arch_loadable(&ModelArch::NonGemma("llama".into()))
            .expect_err("non-gemma must be refused");
        assert!(format!("{err:#}").contains("non-Gemma"));
    }

    #[test]
    fn cpu_is_the_default_device_without_accelerator_features() {
        // In the default (no metal/cuda feature) build this must be CPU.
        let dev = pick_device();
        #[cfg(not(any(feature = "metal", feature = "cuda")))]
        assert_eq!(device_label(&dev), "cpu");
        // Smoke the label mapping under any build.
        let _ = device_label(&dev);
    }
}
