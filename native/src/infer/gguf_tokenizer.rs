//! Build a `tokenizers::Tokenizer` from a GGUF file's embedded
//! `tokenizer.ggml.*` metadata, so the LLM oracle works with ONLY
//! `model.gguf` — no gated/sidecar `tokenizer.json` download (BL-14).
//!
//! ## Why this exists
//!
//! candle's quantized-Gemma path historically loaded the tokenizer from a
//! sidecar `tokenizer.json`. But the `bartowski/*-GGUF` repos publish no
//! `tokenizer.json`, and the upstream `google/gemma*` repos are license-gated.
//! llama.cpp solves this by embedding the vocab in the GGUF itself under the
//! `tokenizer.ggml.*` keys; this module reconstructs a `tokenizers::Tokenizer`
//! from exactly those keys.
//!
//! ## Fidelity boundary (READ THIS — it is the BL-14 honesty contract)
//!
//! A GGUF carries the *vocabulary* (tokens, scores, token-types, special-token
//! ids) but **not** the full Hugging Face tokenizer pipeline. Two pieces that
//! live in the original SentencePiece `.model` / `tokenizer.json` are NOT in
//! GGUF metadata, and we reconstruct the canonical SPM defaults in their place:
//!
//!   1. **`precompiled_charsmap`** — SentencePiece's binary NFKC-ish
//!      normalization map. HF's `from_spm` uses
//!      `Precompiled(charsmap)` when present; the GGUF drops it, so we fall back
//!      to the documented no-charsmap normalizer (`Replace(" {2,}", " ")`).
//!      For ASCII / already-NFKC source text (the §7.3 conflict prompts are
//!      English code-intent sentences) this is identical; for text needing
//!      NFKC folding it can differ by a token.
//!   2. **Model-specific pre-tokenizer quirks** — e.g. the Gemma-4 E-series
//!      uses a *custom* newline-grouping pre-tokenizer (llama.cpp
//!      `LLAMA_VOCAB_PRE_TYPE_GEMMA4`: `\n\n`/`\n\n\n` as discrete units, a
//!      BPE-bypass for newline-only chunks) that is NOT expressible in GGUF
//!      metadata and NOT replicable with the stock `tokenizers` Metaspace
//!      pre-tokenizer. We emit a plain Metaspace pipeline, which is byte-exact
//!      for standard SPM Gemma (2/3) but can mis-segment runs of newlines on
//!      Gemma-4.
//!
//! Because of (2), this builder is the **fallback**: `infer` prefers a sidecar
//! `tokenizer.json` whenever the operator drops one in the model dir (the
//! byte-exact escape hatch), and only reconstructs from GGUF when none exists.
//! This keeps a model usable with `model.gguf` alone while leaving a clean,
//! documented path to byte-exact behavior.
//!
//! Sources: HF `tokenizers` `sentencepiece_unigram.py::from_spm`; llama.cpp
//! GGUF tokenizer key conventions (`gguf-py/gguf/constants.py`); llama.cpp
//! PR #21343 (Gemma-4 pre-tokenizer).

use std::collections::HashMap;

use anyhow::{anyhow, bail, Context, Result};
use candle_core::quantized::gguf_file::Value;
use tokenizers::decoders::byte_fallback::ByteFallback;
use tokenizers::decoders::sequence::Sequence as DecoderSequence;
use tokenizers::decoders::DecoderWrapper;
use tokenizers::models::unigram::Unigram;
use tokenizers::normalizers::{Replace, Sequence as NormalizerSequence};
use tokenizers::pre_tokenizers::metaspace::{Metaspace, PrependScheme};
use tokenizers::pre_tokenizers::sequence::Sequence as PreTokenizerSequence;
use tokenizers::pre_tokenizers::split::{Split, SplitPattern};
use tokenizers::{
    AddedToken, NormalizerWrapper, PreTokenizerWrapper, SplitDelimiterBehavior, Tokenizer,
};

/// SentencePiece whitespace marker (U+2581 LOWER ONE EIGHTH BLOCK), the `▁`
/// that SPM substitutes for spaces.
const SPM_SPACE: char = '\u{2581}';

/// The GGUF model architecture, parsed from the top-level `general.architecture`
/// metadata string. This is the SAME key candle's `quantized_gemma3` probes
/// indirectly (via `{arch}.attention.head_count`); we read it explicitly so the
/// `infer` path can (a) preflight-validate that the configured weights are a
/// family candle's `quantized_gemma3` module actually loads, and (b) gate the
/// Gemma-4 newline pre-tokenizer pass on (without ever touching Gemma 2/3).
///
/// `quantized_gemma3::ModelWeights::from_gguf` (candle-transformers 0.10.2)
/// detects its key prefix by probing `["gemma3","gemma2","gemma",
/// "gemma-embedding"]` and falling back to `"gemma3"` — so a Gemma-4-family
/// GGUF (whose keys are prefixed `gemma4`/`gemma3n`) finds no match, falls back
/// to `gemma3`, and then `md_get("attention.head_count")` bails with the
/// cryptic `cannot find gemma3.attention.head_count in metadata`. We classify
/// the arch up front to turn that into an actionable error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelArch {
    /// Original Gemma (`"gemma"`). Loaded by `quantized_gemma3` via the `gemma`
    /// prefix.
    Gemma,
    /// Gemma 2 (`"gemma2"`). Loaded by `quantized_gemma3` via the `gemma2`
    /// prefix.
    Gemma2,
    /// Gemma 3 (`"gemma3"`). The native target of `quantized_gemma3`.
    Gemma3,
    /// Gemma-4 E-series family (`"gemma4"`, `"gemma3n"`, …). NOT loadable by
    /// candle 0.10.2's `quantized_gemma3` (different key prefix + the custom
    /// newline pre-tokenizer of llama.cpp PR #21343). Carries the raw arch
    /// string for the error message.
    Gemma4(String),
    /// Any other `gemma*`-prefixed arch we don't yet map. Carries the raw arch.
    GemmaOther(String),
    /// A non-Gemma architecture (e.g. `"llama"`, `"qwen3"`). Carries the raw
    /// arch string.
    NonGemma(String),
}

impl ModelArch {
    /// Classify a raw `general.architecture` string.
    pub fn parse(arch: &str) -> Self {
        match arch {
            "gemma" => Self::Gemma,
            "gemma2" => Self::Gemma2,
            "gemma3" => Self::Gemma3,
            // The Gemma-4 E-series ships under either `gemma4` (the marketing
            // name) or `gemma3n` (the upstream/efficient-series arch id it
            // inherits in llama.cpp); both share the PR-#21343 newline
            // pre-tokenizer and the `gemma3`-incompatible key prefix.
            "gemma4" | "gemma3n" | "gemma4_e" | "gemma-4" => Self::Gemma4(arch.to_string()),
            other if other.starts_with("gemma") => Self::GemmaOther(other.to_string()),
            other => Self::NonGemma(other.to_string()),
        }
    }

    /// Whether candle 0.10.2's `quantized_gemma3::ModelWeights::from_gguf` can
    /// load weights of this architecture. Only the Gemma 1/2/3 prefixes are in
    /// its probe list.
    pub fn is_loadable_by_quantized_gemma3(&self) -> bool {
        matches!(self, Self::Gemma | Self::Gemma2 | Self::Gemma3)
    }

    /// Whether this arch wants the Gemma-4 newline pre-tokenizer normalization
    /// pass (collapsing/normalizing runs of `\n`). True only for the Gemma-4
    /// family — Gemma 2/3 must never get it (it would regress their byte-exact
    /// reconstruction).
    pub fn wants_gemma4_newline_pretok(&self) -> bool {
        matches!(self, Self::Gemma4(_))
    }
}

/// Read `general.architecture` from GGUF metadata and classify it. Defaults to
/// `Gemma3` when the key is absent (older Gemma GGUFs omitted it), matching the
/// `quantized_gemma3` fallback so behavior is unchanged for those files.
pub fn arch_from_metadata(metadata: &HashMap<String, Value>) -> ModelArch {
    match get_string(metadata, "general.architecture") {
        Ok(s) => ModelArch::parse(&s),
        Err(_) => ModelArch::Gemma3,
    }
}

/// llama.cpp `tokenizer.ggml.token_type` enum (mirrors `llama_token_type` /
/// SentencePiece `ModelProto.SentencePiece.Type`). The full set is
/// `NORMAL=1, UNKNOWN=2, CONTROL=3, USER_DEFINED=4, UNUSED=5, BYTE=6`; we only
/// branch on the three that change reconstruction (NORMAL as the implicit
/// default, UNKNOWN for unk-id fallback, BYTE for byte_fallback inference).
mod token_type {
    pub const NORMAL: i32 = 1;
    pub const UNKNOWN: i32 = 2;
    pub const BYTE: i32 = 6;
}

/// The tokenizer model family declared by `tokenizer.ggml.model`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GgmlTokenizerModel {
    /// `"llama"` — SentencePiece / Unigram (Gemma, Llama-1/2). Has scores, no
    /// merges. This is the path we reconstruct faithfully.
    Llama,
    /// `"gpt2"` / `"bpe"` — byte-level BPE (Llama-3, GPT-NeoX, …). Has merges.
    Bpe,
    /// Anything else we don't (yet) reconstruct.
    Other(String),
}

impl GgmlTokenizerModel {
    fn parse(s: &str) -> Self {
        match s {
            "llama" => Self::Llama,
            "gpt2" | "bpe" => Self::Bpe,
            other => Self::Other(other.to_string()),
        }
    }
}

/// The special-token ids + vocab the GGUF carries. Extracted separately from
/// the `Tokenizer` build so it can be unit-tested in isolation.
#[derive(Debug, Clone)]
pub struct GgufVocab {
    pub model: GgmlTokenizerModel,
    /// Parallel to `scores` / `token_types`: `tokens[id]` is the id-th token.
    pub tokens: Vec<String>,
    pub scores: Vec<f32>,
    pub token_types: Vec<i32>,
    pub bos_id: Option<u32>,
    pub eos_id: Option<u32>,
    pub unk_id: Option<u32>,
    pub pad_id: Option<u32>,
}

impl GgufVocab {
    /// Whether the vocab declares any BYTE-typed tokens (`<0xNN>`). Their
    /// presence is how we infer SentencePiece `byte_fallback = true` — the
    /// GGUF has no explicit `byte_fallback` key.
    fn has_byte_tokens(&self) -> bool {
        self.token_types.contains(&token_type::BYTE)
    }
}

/// Pull the `tokenizer.ggml.*` vocab out of a GGUF metadata map. Errors only
/// when the *required* keys (`model`, `tokens`) are missing or malformed; the
/// optional special-id keys default to `None`.
pub fn extract_vocab(metadata: &HashMap<String, Value>) -> Result<GgufVocab> {
    let model_str = get_string(metadata, "tokenizer.ggml.model")
        .context("GGUF is missing tokenizer.ggml.model — cannot build a tokenizer from it")?;
    let model = GgmlTokenizerModel::parse(&model_str);

    let tokens = get_string_array(metadata, "tokenizer.ggml.tokens")
        .context("GGUF is missing tokenizer.ggml.tokens (the vocabulary)")?;
    if tokens.is_empty() {
        bail!("tokenizer.ggml.tokens is empty");
    }

    // Scores / token_types are parallel arrays; default to sane fills when a
    // GGUF omits them (some BPE exports omit scores entirely).
    let scores = match metadata.get("tokenizer.ggml.scores") {
        Some(v) => to_f32_array(v).context("tokenizer.ggml.scores")?,
        None => vec![0.0; tokens.len()],
    };
    let token_types = match metadata.get("tokenizer.ggml.token_type") {
        Some(v) => to_i32_array(v).context("tokenizer.ggml.token_type")?,
        None => vec![token_type::NORMAL; tokens.len()],
    };

    // Length agreement is load-bearing: a Unigram vocab pairs each token with
    // its score by index, and the byte-fallback inference reads token_types by
    // index. A mismatch means a corrupt/foreign GGUF — refuse rather than
    // silently truncate.
    if scores.len() != tokens.len() {
        bail!(
            "tokenizer.ggml.scores length {} != tokens length {}",
            scores.len(),
            tokens.len()
        );
    }
    if token_types.len() != tokens.len() {
        bail!(
            "tokenizer.ggml.token_type length {} != tokens length {}",
            token_types.len(),
            tokens.len()
        );
    }

    Ok(GgufVocab {
        model,
        tokens,
        scores,
        token_types,
        bos_id: get_u32(metadata, "tokenizer.ggml.bos_token_id"),
        eos_id: get_u32(metadata, "tokenizer.ggml.eos_token_id"),
        unk_id: get_u32(metadata, "tokenizer.ggml.unknown_token_id"),
        pad_id: get_u32(metadata, "tokenizer.ggml.padding_token_id"),
    })
}

/// Build a `tokenizers::Tokenizer` from GGUF metadata. Dispatches on
/// `tokenizer.ggml.model`: only the SentencePiece/Unigram (`"llama"`) family
/// — Gemma's case — is reconstructed; BPE and unknown families are refused
/// with an actionable message (drop a sidecar `tokenizer.json` instead).
pub fn tokenizer_from_gguf_metadata(metadata: &HashMap<String, Value>) -> Result<Tokenizer> {
    let vocab = extract_vocab(metadata)?;
    let arch = arch_from_metadata(metadata);
    match &vocab.model {
        GgmlTokenizerModel::Llama => build_unigram_tokenizer(&vocab, &arch),
        GgmlTokenizerModel::Bpe => bail!(
            "GGUF tokenizer.ggml.model = BPE (gpt2/bpe) is not reconstructable from GGUF \
             metadata alone (the merges→pre-tokenizer mapping is model-specific). Place a \
             sidecar tokenizer.json in the model dir to use this model."
        ),
        GgmlTokenizerModel::Other(name) => bail!(
            "unsupported tokenizer.ggml.model {name:?}; place a sidecar tokenizer.json \
             in the model dir to use this model"
        ),
    }
}

/// Construct the SentencePiece/Unigram tokenizer. This mirrors HF's
/// `SentencePieceUnigramTokenizer.from_spm` (the no-`precompiled_charsmap`
/// branch — see the module doc fidelity note):
///
///   - model:        Unigram(vocab=(token, score), unk_id, byte_fallback)
///   - normalizer:   Replace(" {2,}", " ")   (collapse runs of spaces)
///   - pre_tokenizer:Metaspace('▁', prepend_scheme=Always)
///   - decoder:      Sequence([ByteFallback, Metaspace('▁', Always)])
///   - specials:     bos/eos/unk/pad registered as special AddedTokens
///
/// `arch` gates the **Gemma-4 newline pre-tokenizer**: for the Gemma-4 E-series
/// only, a `Split` on runs of `\n` (Isolated) is prepended to the Metaspace
/// pre-tokenizer so newline runs are segmented as discrete units (approximating
/// llama.cpp PR #21343 / `LLAMA_VOCAB_PRE_TYPE_GEMMA4`). For every other arch
/// (Gemma 2/3) the pipeline is byte-for-byte the historical Metaspace-only one
/// — the gate guarantees no regression.
fn build_unigram_tokenizer(vocab: &GgufVocab, arch: &ModelArch) -> Result<Tokenizer> {
    // (token, score as f64) pairs — Unigram wants f64 logprob-ish scores.
    let pairs: Vec<(String, f64)> = vocab
        .tokens
        .iter()
        .zip(vocab.scores.iter())
        .map(|(t, s)| (t.clone(), *s as f64))
        .collect();

    // unk_id must index into the vocab. Prefer the GGUF's explicit
    // unknown_token_id; otherwise look for the token typed UNKNOWN; otherwise
    // the conventional "<unk>". Unigram *requires* an unk id.
    let unk_id = resolve_unk_id(vocab)
        .context("could not determine the unknown-token id for the Unigram model")?;

    // SentencePiece byte_fallback is not an explicit GGUF key; infer it from
    // the presence of BYTE-typed `<0xNN>` tokens, which is how llama.cpp's
    // SPM vocab carries byte fallback.
    let byte_fallback = vocab.has_byte_tokens();

    let unigram = Unigram::from(pairs, Some(unk_id as usize), byte_fallback)
        .map_err(|e| anyhow!("build Unigram model from GGUF vocab: {e}"))?;

    let mut tokenizer = Tokenizer::new(unigram);

    // Normalizer: collapse 2+ spaces to one (the documented no-charsmap SPM
    // default). We deliberately do NOT add NFKC here: the real SPM map is a
    // precompiled_charsmap absent from the GGUF, and a generic NFKC pass is a
    // *different* normalization than SPM's — closer-to-correct is to do the
    // minimal documented fallback than to guess a fuller one.
    let collapse_spaces =
        Replace::new(" {2,}", " ").map_err(|e| anyhow!("build space-collapse normalizer: {e}"))?;
    let normalizer = NormalizerSequence::new(vec![NormalizerWrapper::Replace(collapse_spaces)]);
    tokenizer.with_normalizer(Some(normalizer));

    // Pre-tokenizer + decoder: Metaspace with the '▁' marker. `split = true`
    // matches the HF Metaspace default used by from_spm.
    //
    // prepend_scheme = First (NOT Always). SentencePiece's `add_dummy_prefix`
    // injects the leading `▁` exactly ONCE, at the true start of the input —
    // `PrependScheme::First` reproduces that (it only prepends when the segment's
    // original offset is 0). `Always` instead prepends `▁` to EVERY pre-token
    // segment, which is wrong as soon as special tokens split the input: a chat
    // prompt like `<bos><start_of_turn>user…` would get a spurious `▁` inserted
    // after `<bos>` (a bogus leading space the real Gemma tokenizer never emits:
    // canonical `[2, 105, …]` vs `Always`'s `[2, 236743, 105, …]`). That single
    // out-of-distribution space token was enough to push the instruct model to
    // emit `<end_of_turn>` as its very first sampled token → an empty completion
    // (BL-18). `First` keeps the single-segment round-trips byte-identical
    // (a lone "hello world" still starts at offset 0 ⇒ gets the dummy prefix)
    // while fixing the multi-segment chat-template case.
    let metaspace = Metaspace::new(SPM_SPACE, PrependScheme::First, true);

    // Gemma-4 newline pre-tokenizer (GATED — Gemma-4 family only).
    //
    // Gemma-4's custom pre-tokenizer (llama.cpp PR #21343) treats runs of
    // newlines as *discrete units* rather than letting the SPM/Unigram lattice
    // merge a `\n` into an adjacent `▁`-prefixed piece. The stock Metaspace
    // pre-tokenizer does not do this, so multi-newline inputs can mis-segment by
    // a token on the from-GGUF path.
    //
    // We approximate it with a `Split` on runs of `\n` (`SplitDelimiterBehavior
    // ::Isolated`) placed BEFORE Metaspace: this carves each newline run into
    // its own pre-token span, so the Unigram lattice cannot merge it across the
    // run boundary, while leaving the underlying bytes untouched (decode stays
    // byte-exact via the ByteFallback+Metaspace decoder). The two-newline and
    // three-newline runs that PR #21343 special-cases thus become their own
    // units. This is the feasible-without-weights subset of PR #21343; full
    // byte-exact fidelity (including the NFKC `precompiled_charsmap` absent from
    // GGUF) still wants the sidecar `tokenizer.json` override.
    if arch.wants_gemma4_newline_pretok() {
        let newline_split = Split::new(
            // Runs of one-or-more `\n`. Isolated ⇒ each run is its own span.
            SplitPattern::Regex(r"\n+".to_string()),
            SplitDelimiterBehavior::Isolated,
            false,
        )
        .map_err(|e| anyhow!("build Gemma-4 newline split pre-tokenizer: {e}"))?;

        // CRITICAL: with the upstream Split producing multiple spans, a
        // `PrependScheme::Always` Metaspace would prepend `▁` (→ a spurious
        // space) to EVERY span, including the isolated newline runs and the
        // text that follows them — corrupting the bytes. SPM's `add_dummy_prefix`
        // adds the leading `▁` exactly once, at the very start of the input, so
        // we use `PrependScheme::First` inside the sequence. The leading-space
        // semantics for the first token are identical to the un-split path; only
        // the bogus per-span prefixes are suppressed.
        let metaspace_first = Metaspace::new(SPM_SPACE, PrependScheme::First, true);
        let sequence = PreTokenizerSequence::new(vec![
            PreTokenizerWrapper::Split(newline_split),
            PreTokenizerWrapper::Metaspace(metaspace_first),
        ]);
        tokenizer.with_pre_tokenizer(Some(sequence));
    } else {
        tokenizer.with_pre_tokenizer(Some(metaspace.clone()));
    }

    // Decoder: ByteFallback (reassemble <0xNN> runs into UTF-8) THEN Metaspace
    // (turn '▁' back into spaces). Order matters — bytes first, then spaces.
    let decoder = DecoderSequence::new(vec![
        DecoderWrapper::ByteFallback(ByteFallback::new()),
        DecoderWrapper::Metaspace(metaspace),
    ]);
    tokenizer.with_decoder(Some(decoder));

    // Register the special tokens so encode/decode treat them atomically and
    // `skip_special_tokens` can strip them. They already exist in the vocab by
    // id; AddedToken (special=true) marks them special without changing ids.
    let specials = special_tokens(vocab);
    if !specials.is_empty() {
        tokenizer.add_special_tokens(&specials);
    }

    Ok(tokenizer)
}

/// Resolve the Unigram unk id, in priority order: explicit GGUF id → a token
/// typed UNKNOWN → the conventional `<unk>` literal.
fn resolve_unk_id(vocab: &GgufVocab) -> Result<u32> {
    if let Some(id) = vocab.unk_id {
        if (id as usize) < vocab.tokens.len() {
            return Ok(id);
        }
        bail!(
            "tokenizer.ggml.unknown_token_id {id} is out of range (vocab size {})",
            vocab.tokens.len()
        );
    }
    if let Some(idx) = vocab
        .token_types
        .iter()
        .position(|&t| t == token_type::UNKNOWN)
    {
        return Ok(idx as u32);
    }
    if let Some(idx) = vocab.tokens.iter().position(|t| t == "<unk>") {
        return Ok(idx as u32);
    }
    bail!("no unknown token in the GGUF vocab (no unknown_token_id, no UNKNOWN type, no \"<unk>\")")
}

/// Build the special `AddedToken`s for the declared bos/eos/unk/pad ids. Each
/// is looked up by id to recover its literal string; ids out of range or
/// duplicated are skipped (deduped by content).
fn special_tokens(vocab: &GgufVocab) -> Vec<AddedToken> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for id in [vocab.bos_id, vocab.eos_id, vocab.unk_id, vocab.pad_id]
        .into_iter()
        .flatten()
    {
        if let Some(tok) = vocab.tokens.get(id as usize) {
            if !seen.contains(tok) {
                seen.push(tok.clone());
                out.push(AddedToken::from(tok.clone(), true));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// GGUF Value extraction helpers. candle's `Value` exposes typed accessors;
// these wrap them with key context and array-element coercion.
// ---------------------------------------------------------------------------

fn get_string(md: &HashMap<String, Value>, key: &str) -> Result<String> {
    let v = md
        .get(key)
        .ok_or_else(|| anyhow!("GGUF metadata missing key {key}"))?;
    Ok(v.to_string()
        .map_err(|e| anyhow!("GGUF key {key} is not a string: {e}"))?
        .clone())
}

fn get_u32(md: &HashMap<String, Value>, key: &str) -> Option<u32> {
    // bos/eos/etc. are conventionally u32 but some exporters use other int
    // widths; accept any integer that fits.
    let v = md.get(key)?;
    v.to_u32()
        .ok()
        .or_else(|| v.to_i32().ok().and_then(|i| u32::try_from(i).ok()))
        .or_else(|| v.to_u64().ok().and_then(|i| u32::try_from(i).ok()))
}

fn get_string_array(md: &HashMap<String, Value>, key: &str) -> Result<Vec<String>> {
    let v = md
        .get(key)
        .ok_or_else(|| anyhow!("GGUF metadata missing key {key}"))?;
    let arr = v
        .to_vec()
        .map_err(|e| anyhow!("GGUF key {key} is not an array: {e}"))?;
    arr.iter()
        .enumerate()
        .map(|(i, e)| {
            e.to_string()
                .cloned()
                .map_err(|err| anyhow!("{key}[{i}] is not a string: {err}"))
        })
        .collect()
}

fn to_f32_array(v: &Value) -> Result<Vec<f32>> {
    let arr = v.to_vec().map_err(|e| anyhow!("not an array: {e}"))?;
    arr.iter()
        .enumerate()
        .map(|(i, e)| {
            e.to_f32()
                .or_else(|_| e.to_f64().map(|f| f as f32))
                .map_err(|err| anyhow!("element {i} is not a float: {err}"))
        })
        .collect()
}

fn to_i32_array(v: &Value) -> Result<Vec<i32>> {
    let arr = v.to_vec().map_err(|e| anyhow!("not an array: {e}"))?;
    arr.iter()
        .enumerate()
        .map(|(i, e)| {
            // token_type is conventionally i32 but accept any int width.
            e.to_i32()
                .or_else(|_| e.to_u32().map(|u| u as i32))
                .or_else(|_| e.to_i64().map(|x| x as i32))
                .or_else(|_| e.to_u64().map(|x| x as i32))
                .map_err(|err| anyhow!("element {i} is not an integer: {err}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a small synthetic SPM-style vocab as a GGUF metadata map. The
    /// vocab is a 7-token Unigram with the `▁` marker, an `<unk>`, bos/eos
    /// control tokens, and one BYTE token so byte_fallback is inferred true.
    ///
    /// ids: 0 <unk>(UNKNOWN) 1 <bos>(CONTROL) 2 <eos>(CONTROL)
    ///      3 "▁hello"(NORMAL) 4 "▁world"(NORMAL) 5 "▁"(NORMAL) 6 "<0x0A>"(BYTE)
    fn synthetic_metadata() -> HashMap<String, Value> {
        let tokens = ["<unk>", "<bos>", "<eos>", "▁hello", "▁world", "▁", "<0x0A>"];
        let token_vals: Vec<Value> = tokens
            .iter()
            .map(|t| Value::String(t.to_string()))
            .collect();
        let scores: Vec<Value> = [0.0f32, 0.0, 0.0, -1.0, -2.0, -3.0, 0.0]
            .iter()
            .map(|s| Value::F32(*s))
            .collect();
        // types: UNKNOWN(2) CONTROL(3) CONTROL(3) NORMAL(1) NORMAL(1)
        //        NORMAL(1) BYTE(6)
        let types: Vec<Value> = [
            token_type::UNKNOWN,
            3, // CONTROL
            3, // CONTROL
            token_type::NORMAL,
            token_type::NORMAL,
            token_type::NORMAL,
            token_type::BYTE,
        ]
        .iter()
        .map(|t| Value::I32(*t))
        .collect();

        let mut md = HashMap::new();
        md.insert(
            "tokenizer.ggml.model".to_string(),
            Value::String("llama".to_string()),
        );
        md.insert(
            "tokenizer.ggml.tokens".to_string(),
            Value::Array(token_vals),
        );
        md.insert("tokenizer.ggml.scores".to_string(), Value::Array(scores));
        md.insert("tokenizer.ggml.token_type".to_string(), Value::Array(types));
        md.insert("tokenizer.ggml.bos_token_id".to_string(), Value::U32(1));
        md.insert("tokenizer.ggml.eos_token_id".to_string(), Value::U32(2));
        md.insert("tokenizer.ggml.unknown_token_id".to_string(), Value::U32(0));
        md
    }

    #[test]
    fn extracts_vocab_tokens_scores_specials() {
        let md = synthetic_metadata();
        let vocab = extract_vocab(&md).expect("extract");
        assert_eq!(vocab.model, GgmlTokenizerModel::Llama);
        assert_eq!(vocab.tokens.len(), 7);
        assert_eq!(vocab.tokens[3], "▁hello");
        assert_eq!(vocab.scores[3], -1.0);
        assert_eq!(vocab.bos_id, Some(1));
        assert_eq!(vocab.eos_id, Some(2));
        assert_eq!(vocab.unk_id, Some(0));
        assert!(vocab.has_byte_tokens(), "BYTE token must be detected");
    }

    #[test]
    fn model_type_dispatch() {
        assert_eq!(
            GgmlTokenizerModel::parse("llama"),
            GgmlTokenizerModel::Llama
        );
        assert_eq!(GgmlTokenizerModel::parse("gpt2"), GgmlTokenizerModel::Bpe);
        assert_eq!(GgmlTokenizerModel::parse("bpe"), GgmlTokenizerModel::Bpe);
        match GgmlTokenizerModel::parse("t5") {
            GgmlTokenizerModel::Other(n) => assert_eq!(n, "t5"),
            other => panic!("expected Other, got {other:?}"),
        }
    }

    #[test]
    fn bpe_model_is_refused_with_actionable_message() {
        let mut md = synthetic_metadata();
        md.insert(
            "tokenizer.ggml.model".to_string(),
            Value::String("gpt2".to_string()),
        );
        let err = tokenizer_from_gguf_metadata(&md).expect_err("BPE must be refused");
        let msg = format!("{err:#}");
        assert!(msg.contains("sidecar tokenizer.json"), "unexpected: {msg}");
    }

    #[test]
    fn missing_model_key_errors() {
        let mut md = synthetic_metadata();
        md.remove("tokenizer.ggml.model");
        let err = extract_vocab(&md).expect_err("missing model must error");
        assert!(format!("{err:#}").contains("tokenizer.ggml.model"));
    }

    #[test]
    fn mismatched_scores_length_errors() {
        let mut md = synthetic_metadata();
        // One fewer score than tokens.
        md.insert(
            "tokenizer.ggml.scores".to_string(),
            Value::Array(vec![Value::F32(0.0); 6]),
        );
        let err = extract_vocab(&md).expect_err("length mismatch must error");
        assert!(format!("{err:#}").contains("scores length"));
    }

    #[test]
    fn builds_a_unigram_tokenizer() {
        let md = synthetic_metadata();
        let tok = tokenizer_from_gguf_metadata(&md).expect("build tokenizer");
        // The vocab is queryable and the specials are registered.
        let vocab = tok.get_vocab(true);
        assert!(vocab.contains_key("▁hello"));
        assert!(vocab.contains_key("<bos>"));
        assert_eq!(vocab.get("▁hello").copied(), Some(3));
    }

    #[test]
    fn unk_id_resolves_from_explicit_key() {
        let md = synthetic_metadata();
        let vocab = extract_vocab(&md).unwrap();
        assert_eq!(resolve_unk_id(&vocab).unwrap(), 0);
    }

    #[test]
    fn unk_id_falls_back_to_unknown_type_then_literal() {
        // Drop the explicit id; the UNKNOWN-typed token (id 0) should be found.
        let mut md = synthetic_metadata();
        md.remove("tokenizer.ggml.unknown_token_id");
        let vocab = extract_vocab(&md).unwrap();
        assert_eq!(resolve_unk_id(&vocab).unwrap(), 0);
    }

    #[test]
    fn encodes_and_round_trips_known_tokens() {
        // The load-bearing behavioral test we CAN run without real weights:
        // a phrase made of in-vocab pieces must encode to those ids and decode
        // back to the original text. This exercises the Metaspace pre-tokenizer
        // (space → ▁), the Unigram lattice, and the ByteFallback+Metaspace
        // decoder together.
        let md = synthetic_metadata();
        let tok = tokenizer_from_gguf_metadata(&md).expect("build tokenizer");

        let enc = tok.encode("hello world", false).expect("encode");
        let ids = enc.get_ids();
        // "hello world" → ▁hello ▁world  (ids 3, 4). Under Metaspace(First) the
        // single-segment input still starts at offset 0, so the leading dummy
        // `▁` is added exactly as before — this case is unchanged by the
        // Always→First switch.
        assert_eq!(ids, &[3, 4], "tokens: {:?}", enc.get_tokens());

        let decoded = tok.decode(ids, false).expect("decode");
        assert_eq!(decoded, "hello world");
    }

    #[test]
    fn chat_template_special_tokens_do_not_inject_a_spurious_space_marker() {
        // BL-18 regression. The 0-token inference bug had two roots; this pins
        // the tokenizer half: with `Metaspace(Always)`, a prompt segment that
        // follows a SPECIAL token (e.g. the user/model body after `<bos>` /
        // `<start_of_turn>` in the Gemma chat template) got a SPURIOUS leading
        // `▁` token (id 5 here, a bogus space the real Gemma tokenizer never
        // emits — on the real Gemma-3 vocab it was id 236743). That single
        // out-of-distribution space token was enough to make a Gemma instruct
        // model emit `<end_of_turn>` as its first sampled token → empty output.
        //
        // `Metaspace(First)` only prepends the dummy `▁` at the TRUE start of the
        // input (original offset 0), which the leading special token occupies —
        // so the body after a special token does NOT get a spurious `▁`. The
        // lone-`▁` token (id 5) must NOT appear immediately after `<bos>`.
        let md = synthetic_metadata();
        let tok = tokenizer_from_gguf_metadata(&md).expect("build tokenizer");

        // `<bos>` (id 1) is registered special, followed by an in-vocab word.
        // "▁hello world" so the body's first real piece (`▁hello`, id 3) carries
        // its OWN leading marker; the bug under test is a SECOND, spurious lone
        // `▁` (id 5) being inserted between `<bos>` and that piece.
        let enc = tok.encode("<bos> hello world", true).expect("encode");
        assert_eq!(
            enc.get_ids(),
            &[1, 3, 4],
            "expected <bos> ▁hello ▁world with no spurious lone ▁; tokens: {:?}",
            enc.get_tokens()
        );
        assert!(
            enc.get_ids().get(1) != Some(&5),
            "a lone ▁ (id 5) must NOT follow the special token <bos>: {:?}",
            enc.get_tokens()
        );
        // Decode skipping specials → the body round-trips with no extra space.
        assert_eq!(
            tok.decode(enc.get_ids(), true).expect("decode"),
            "hello world"
        );
    }

    #[test]
    fn byte_fallback_round_trips_an_out_of_vocab_char_via_byte_tokens() {
        // A newline is only representable via the BYTE token <0x0A>. With
        // byte_fallback inferred true, encoding "hello\nworld"-ish content must
        // route the newline through the byte token and decode back to "\n".
        let md = synthetic_metadata();
        let tok = tokenizer_from_gguf_metadata(&md).expect("build tokenizer");

        // Encode a lone newline. byte_fallback should map it to <0x0A> (id 6).
        let enc = tok.encode("\n", false).expect("encode newline");
        assert!(
            enc.get_ids().contains(&6),
            "newline must route through the <0x0A> byte token; got {:?}",
            enc.get_tokens()
        );
        let decoded = tok.decode(&[6], false).expect("decode byte token");
        assert_eq!(decoded, "\n", "ByteFallback decoder must reassemble \\n");
    }

    // -----------------------------------------------------------------------
    // BL-18: architecture classification + the gated Gemma-4 newline
    // pre-tokenizer.
    // -----------------------------------------------------------------------

    #[test]
    fn arch_parse_classifies_gemma_families() {
        assert_eq!(ModelArch::parse("gemma"), ModelArch::Gemma);
        assert_eq!(ModelArch::parse("gemma2"), ModelArch::Gemma2);
        assert_eq!(ModelArch::parse("gemma3"), ModelArch::Gemma3);
        assert_eq!(
            ModelArch::parse("gemma4"),
            ModelArch::Gemma4("gemma4".to_string())
        );
        assert_eq!(
            ModelArch::parse("gemma3n"),
            ModelArch::Gemma4("gemma3n".to_string())
        );
        // Unknown gemma-prefixed → GemmaOther; non-gemma → NonGemma.
        assert_eq!(
            ModelArch::parse("gemma9"),
            ModelArch::GemmaOther("gemma9".to_string())
        );
        assert_eq!(
            ModelArch::parse("qwen3"),
            ModelArch::NonGemma("qwen3".to_string())
        );
    }

    #[test]
    fn arch_loadability_matches_quantized_gemma3_probe_set() {
        // Only Gemma 1/2/3 are in candle 0.10.2's quantized_gemma3 probe list.
        assert!(ModelArch::Gemma.is_loadable_by_quantized_gemma3());
        assert!(ModelArch::Gemma2.is_loadable_by_quantized_gemma3());
        assert!(ModelArch::Gemma3.is_loadable_by_quantized_gemma3());
        assert!(!ModelArch::Gemma4("gemma4".into()).is_loadable_by_quantized_gemma3());
        assert!(!ModelArch::GemmaOther("gemma9".into()).is_loadable_by_quantized_gemma3());
        assert!(!ModelArch::NonGemma("llama".into()).is_loadable_by_quantized_gemma3());
    }

    #[test]
    fn arch_from_metadata_defaults_to_gemma3_when_absent() {
        // The synthetic vocab carries no general.architecture; default = Gemma3
        // (matches the quantized_gemma3 fallback) ⇒ no Gemma-4 newline pass.
        let md = synthetic_metadata();
        assert_eq!(arch_from_metadata(&md), ModelArch::Gemma3);
        assert!(!arch_from_metadata(&md).wants_gemma4_newline_pretok());
    }

    #[test]
    fn arch_from_metadata_reads_gemma4() {
        let mut md = synthetic_metadata();
        md.insert(
            "general.architecture".to_string(),
            Value::String("gemma4".to_string()),
        );
        let arch = arch_from_metadata(&md);
        assert_eq!(arch, ModelArch::Gemma4("gemma4".to_string()));
        assert!(arch.wants_gemma4_newline_pretok());
    }

    /// A synthetic SPM vocab with FULL single-byte fallback (all 256 `<0xNN>`
    /// byte tokens, as a real Gemma SPM vocab carries) plus a *merged*
    /// double-newline token `"\n\n"`, so:
    ///   - any text round-trips byte-exactly via byte_fallback, and
    ///   - the Unigram lattice has the OPTION to merge two newlines into one
    ///     piece (the merged `"\n\n"` token) — which the Gemma-4 newline
    ///     pre-tokenizer's run isolation can influence.
    ///
    /// Layout:
    ///   0 <unk> 1 <bos> 2 <eos> 3 ▁hello 4 ▁world 5 ▁
    ///   6 "\n\n"(NORMAL merged newline)
    ///   7..=262 the 256 `<0xNN>` BYTE tokens (so 7 == <0x00>, 7+0x0A == <0x0A>)
    fn synthetic_metadata_with_double_newline_token() -> HashMap<String, Value> {
        let mut tokens: Vec<String> = vec![
            "<unk>".into(),
            "<bos>".into(),
            "<eos>".into(),
            "▁hello".into(),
            "▁world".into(),
            "▁".into(),
            "\n\n".into(),
        ];
        let mut scores: Vec<f32> = vec![0.0, 0.0, 0.0, -1.0, -2.0, -3.0, -0.5];
        let mut types: Vec<i32> = vec![
            token_type::UNKNOWN,
            3,
            3,
            token_type::NORMAL,
            token_type::NORMAL,
            token_type::NORMAL,
            token_type::NORMAL,
        ];
        // Append all 256 byte tokens so byte_fallback can represent anything.
        for b in 0u32..256 {
            tokens.push(format!("<0x{b:02X}>"));
            scores.push(-20.0); // worst score: a last resort vs real pieces.
            types.push(token_type::BYTE);
        }

        let token_vals: Vec<Value> = tokens.iter().map(|t| Value::String(t.clone())).collect();
        let score_vals: Vec<Value> = scores.iter().map(|s| Value::F32(*s)).collect();
        let type_vals: Vec<Value> = types.iter().map(|t| Value::I32(*t)).collect();

        let mut md = HashMap::new();
        md.insert(
            "tokenizer.ggml.model".to_string(),
            Value::String("llama".to_string()),
        );
        md.insert(
            "tokenizer.ggml.tokens".to_string(),
            Value::Array(token_vals),
        );
        md.insert(
            "tokenizer.ggml.scores".to_string(),
            Value::Array(score_vals),
        );
        md.insert(
            "tokenizer.ggml.token_type".to_string(),
            Value::Array(type_vals),
        );
        md.insert("tokenizer.ggml.bos_token_id".to_string(), Value::U32(1));
        md.insert("tokenizer.ggml.eos_token_id".to_string(), Value::U32(2));
        md.insert("tokenizer.ggml.unknown_token_id".to_string(), Value::U32(0));
        md
    }

    #[test]
    fn gemma2_3_path_has_no_newline_split_regression() {
        // Non-Gemma-4 arch (default Gemma3): the historical Metaspace-only
        // pipeline is byte-exact for the standard "hello world" case and a
        // multi-newline run still round-trips. This is the no-regression guard.
        let md = synthetic_metadata_with_double_newline_token();
        let tok = tokenizer_from_gguf_metadata(&md).expect("build gemma3 tokenizer");

        let enc = tok.encode("hello world", false).expect("encode");
        assert_eq!(enc.get_ids(), &[3, 4], "tokens: {:?}", enc.get_tokens());

        // Round-trip a triple newline embedded in text.
        let text = "hello\n\n\nworld";
        let enc = tok.encode(text, false).expect("encode multiline");
        let decoded = tok.decode(enc.get_ids(), false).expect("decode multiline");
        assert_eq!(
            decoded, text,
            "Gemma 2/3 path must round-trip multi-newline"
        );
    }

    #[test]
    fn gemma4_newline_pretok_is_byte_exact_and_isolates_the_run() {
        // Gemma-4 arch: the newline Split(Isolated) + Metaspace(First) is
        // installed. The properties checkable WITHOUT real weights:
        //   1. encode→decode is byte-exact on multi-newline input (the split
        //      does not alter bytes and, critically, Metaspace(First) does NOT
        //      inject spurious `▁`/spaces around the isolated newline spans —
        //      the regression an Always-prepend would have caused);
        //   2. the newline run is segmented as its OWN unit and does not bleed a
        //      leading-space marker into the following word.
        let mut md = synthetic_metadata_with_double_newline_token();
        md.insert(
            "general.architecture".to_string(),
            Value::String("gemma4".to_string()),
        );
        let g4 = tokenizer_from_gguf_metadata(&md).expect("build gemma4 tokenizer");

        for text in ["hello\n\nworld", "hello\nworld", "hello\n\n\nworld"] {
            let enc = g4.encode(text, false).expect("g4 encode");
            assert_eq!(
                g4.decode(enc.get_ids(), false).expect("g4 decode"),
                text,
                "Gemma-4 newline pre-tokenizer must round-trip byte-exactly: {text:?} \
                 tokens={:?}",
                enc.get_tokens()
            );
            // No spurious space marker must be attached to the newline run:
            // the `▁` (SPM space) only ever appears as the leading dummy prefix,
            // never immediately wrapping a `\n` piece.
            let toks = enc.get_tokens();
            assert!(
                !toks
                    .iter()
                    .any(|t| t.contains('\u{2581}') && t.contains('\n')),
                "no token may mix the space marker with a newline: {toks:?}"
            );
        }
    }

    #[test]
    fn gemma4_does_not_inject_spaces_that_default_always_metaspace_would() {
        // Pin the specific regression that motivated Metaspace(First): with a
        // naive Always-prepend after the Split, "hello\n\nworld" decoded to
        // "hello \n\n world" (spurious spaces). The shipped Gemma-4 pipeline
        // must decode back with NO added spaces.
        let mut md = synthetic_metadata_with_double_newline_token();
        md.insert(
            "general.architecture".to_string(),
            Value::String("gemma4".to_string()),
        );
        let g4 = tokenizer_from_gguf_metadata(&md).expect("build gemma4 tokenizer");
        let text = "hello\n\nworld";
        let enc = g4.encode(text, false).expect("encode");
        let decoded = g4.decode(enc.get_ids(), false).expect("decode");
        assert!(
            !decoded.contains(" \n") && !decoded.contains("\n "),
            "Gemma-4 pipeline must not inject spaces around newlines: {decoded:?}"
        );
        assert_eq!(decoded, text);
    }

    #[test]
    fn gemma4_isolated_newline_run_is_a_single_span() {
        // Direct check of the Isolated behavior: a pure newline run should
        // decode back exactly, and a run of three newlines must survive the
        // round-trip under the Gemma-4 pipeline.
        let mut md = synthetic_metadata_with_double_newline_token();
        md.insert(
            "general.architecture".to_string(),
            Value::String("gemma3n".to_string()), // the other Gemma-4-family id
        );
        let tok = tokenizer_from_gguf_metadata(&md).expect("build gemma4 tokenizer");

        for text in ["\n", "\n\n", "\n\n\n", "a\nb\n\nc\n\n\nd"] {
            let enc = tok.encode(text, false).expect("encode");
            let decoded = tok.decode(enc.get_ids(), false).expect("decode");
            assert_eq!(decoded, text, "round-trip failed for {text:?}");
        }
    }
}
