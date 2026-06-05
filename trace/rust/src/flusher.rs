//! Periodic flush of aggregated observations to the daemon.
//!
//! Mirrors the Python collector's flusher:
//!
//! * Builds the **wire payload** (hand-rolled JSON — the shape is tiny and
//!   fixed; pulling `serde` would violate the zero-runtime-dep discipline,
//!   PRD §2.4).
//! * Carries **both** the raw `observed` count and the scaled
//!   `weight = observed * sample_rate`. The daemon recomputes and rejects
//!   (HTTP 400) if `weight` is off by more than ±1 — so we never apply hidden
//!   scaling.
//! * Runs on a **background thread** at a fixed interval; also exposes a
//!   manual [`Flusher::flush_once`] and a [`Flusher::stop`] that flushes on
//!   shutdown.
//! * The transport is **injectable** (a [`Sender`]) so tests run against a
//!   mock with no live daemon. The default transport is a hand-rolled
//!   HTTP/1.1 POST over [`std::net::TcpStream`] (localhost, fixed small
//!   payload — no heavy HTTP client needed).
//! * If the daemon is **unreachable** the flush no-ops gracefully (logs at
//!   `trace!` level) — it never panics or propagates into user code.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::aggregator::{Aggregator, Observation};

/// Injectable transport. Given the resolved URL and the encoded JSON body,
/// either deliver it or return an error (which the flusher swallows).
///
/// `Send + Sync + 'static` so the background thread can own a clone.
pub trait Sender: Send + Sync + 'static {
    fn send(&self, url: &str, payload: &[u8]) -> Result<(), String>;
}

/// Blanket impl so a plain closure can be used as a [`Sender`] (handy in tests).
impl<F> Sender for F
where
    F: Fn(&str, &[u8]) -> Result<(), String> + Send + Sync + 'static,
{
    fn send(&self, url: &str, payload: &[u8]) -> Result<(), String> {
        (self)(url, payload)
    }
}

/// The default transport: a minimal hand-rolled HTTP/1.1 POST.
///
/// Justification (see README "Dependencies"): the daemon lives on localhost
/// and the payload is a small fixed JSON shape. A blocking single-shot POST
/// over `TcpStream` with a bounded connect/read timeout is a few dozen lines
/// and avoids dragging in a full async/TLS HTTP client. If you ever need
/// TLS or a remote daemon, inject a different [`Sender`].
pub struct HttpSender {
    timeout: Duration,
}

impl HttpSender {
    pub fn new(timeout: Duration) -> Self {
        Self { timeout }
    }
}

impl Sender for HttpSender {
    fn send(&self, url: &str, payload: &[u8]) -> Result<(), String> {
        let (host, port, path) = parse_http_url(url)?;
        let addr = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("resolve {host}:{port}: {e}"))?
            .next()
            .ok_or_else(|| format!("no address for {host}:{port}"))?;

        let mut stream = TcpStream::connect_timeout(&addr, self.timeout)
            .map_err(|e| format!("connect {addr}: {e}"))?;
        stream
            .set_write_timeout(Some(self.timeout))
            .map_err(|e| format!("set_write_timeout: {e}"))?;
        stream
            .set_read_timeout(Some(self.timeout))
            .map_err(|e| format!("set_read_timeout: {e}"))?;

        let req = format!(
            "POST {path} HTTP/1.1\r\n\
             Host: {host}:{port}\r\n\
             User-Agent: hayven-trace/{}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n",
            crate::VERSION,
            payload.len(),
        );
        stream
            .write_all(req.as_bytes())
            .map_err(|e| format!("write headers: {e}"))?;
        stream
            .write_all(payload)
            .map_err(|e| format!("write body: {e}"))?;
        stream.flush().map_err(|e| format!("flush: {e}"))?;

        // Read just enough to learn the status line; we don't need the body.
        let mut buf = [0u8; 64];
        let n = stream.read(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]);
        // Expect "HTTP/1.1 200 ...". Treat 2xx as success; anything else
        // (including the daemon's 400 rejection) is an error the flusher logs.
        if let Some(code) = head.split_whitespace().nth(1) {
            if code.starts_with('2') {
                return Ok(());
            }
            return Err(format!("daemon responded {code}"));
        }
        // Empty/garbled response (e.g. connection reset) — treat as failure
        // so the data simply isn't delivered this round.
        Err("no HTTP status line in response".to_string())
    }
}

/// Parse `http://host:port/path` into `(host, port, path)`.
///
/// Deliberately minimal — only the `http` scheme is supported (the daemon is
/// plain HTTP on localhost). Returns an error for `https`/missing host so the
/// caller can inject a real client if they need TLS.
fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// URLs are supported by the default sender: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err(format!("missing host in URL: {url}"));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>()
                .map_err(|_| format!("invalid port in URL: {url}"))?,
        ),
        None => (authority.to_string(), 80),
    };
    Ok((host, port, path.to_string()))
}

/// Background flusher that drains an [`Aggregator`] on an interval.
pub struct Flusher {
    agg: Arc<Aggregator>,
    url: String,
    interval: Duration,
    sample_rate: u64,
    sender: Arc<dyn Sender>,
    source: String,

    // Shutdown signalling: the background thread waits on the condvar so
    // `stop()` is responsive without busy-polling.
    stop_flag: Arc<AtomicBool>,
    stop_pair: Arc<(Mutex<bool>, Condvar)>,
    handle: Option<JoinHandle<()>>,

    last_flush_count: Arc<AtomicU64>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl Flusher {
    /// Construct a flusher. `daemon_url` is the daemon **base** URL; the
    /// `/api/traces/observations` path is appended automatically.
    pub fn new(
        agg: Arc<Aggregator>,
        daemon_url: &str,
        interval: Duration,
        sample_rate: u64,
        source: impl Into<String>,
        sender: Arc<dyn Sender>,
    ) -> Self {
        let url = format!(
            "{}/api/traces/observations",
            daemon_url.trim_end_matches('/')
        );
        Self {
            agg,
            url,
            interval,
            sample_rate: sample_rate.max(1),
            sender,
            source: source.into(),
            stop_flag: Arc::new(AtomicBool::new(false)),
            stop_pair: Arc::new((Mutex::new(false), Condvar::new())),
            handle: None,
            last_flush_count: Arc::new(AtomicU64::new(0)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }

    /// The resolved POST URL (`<daemon_url>/api/traces/observations`).
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Start the background flush thread (idempotent).
    pub fn start(&mut self) {
        if self.handle.is_some() {
            return;
        }
        self.stop_flag.store(false, Ordering::SeqCst);
        {
            let (lock, _cv) = &*self.stop_pair;
            *lock.lock().unwrap_or_else(|p| p.into_inner()) = false;
        }

        let agg = Arc::clone(&self.agg);
        let url = self.url.clone();
        let interval = self.interval;
        let sample_rate = self.sample_rate;
        let sender = Arc::clone(&self.sender);
        let source = self.source.clone();
        let stop_flag = Arc::clone(&self.stop_flag);
        let stop_pair = Arc::clone(&self.stop_pair);
        let last_count = Arc::clone(&self.last_flush_count);
        let last_error = Arc::clone(&self.last_error);

        let handle = std::thread::Builder::new()
            .name("hayven-trace-flusher".to_string())
            .spawn(move || loop {
                // Wait up to `interval`, but wake immediately on stop.
                let (lock, cv) = &*stop_pair;
                let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
                let (guard, _timeout) = cv
                    .wait_timeout_while(guard, interval, |stopping| !*stopping)
                    .unwrap_or_else(|p| p.into_inner());
                let stopping = *guard;
                drop(guard);
                if stopping || stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                flush_inner(
                    &agg,
                    &url,
                    sample_rate,
                    &source,
                    sender.as_ref(),
                    &last_count,
                    &last_error,
                );
            })
            .expect("spawn hayven-trace flusher thread");

        self.handle = Some(handle);
    }

    /// Stop the background thread. If `flush` is true, drain + POST one final
    /// batch (the shutdown flush).
    pub fn stop(&mut self, flush: bool) {
        self.stop_flag.store(true, Ordering::SeqCst);
        {
            let (lock, cv) = &*self.stop_pair;
            *lock.lock().unwrap_or_else(|p| p.into_inner()) = true;
            cv.notify_all();
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        if flush {
            self.flush_once();
        }
    }

    /// Drain and POST once. Returns the number of observations sent (drained).
    ///
    /// Errors from the transport are swallowed (stashed on `last_error`,
    /// logged at `trace!`); they never propagate into user code.
    pub fn flush_once(&self) -> usize {
        flush_inner(
            &self.agg,
            &self.url,
            self.sample_rate,
            &self.source,
            self.sender.as_ref(),
            &self.last_flush_count,
            &self.last_error,
        )
    }

    /// The number of observations in the most recent successful flush.
    pub fn last_flush_count(&self) -> u64 {
        self.last_flush_count.load(Ordering::SeqCst)
    }

    /// The most recent transport error (if the last flush failed).
    pub fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl Drop for Flusher {
    fn drop(&mut self) {
        // Ensure the background thread is torn down even if the caller forgot
        // to `stop()`. Don't force a final flush here (the caller may have
        // already done it); just join the thread.
        if self.handle.is_some() {
            self.stop(false);
        }
    }
}

/// Drain the aggregator, encode, and hand the payload to the sender.
/// Shared by the manual and background flush paths.
#[allow(clippy::too_many_arguments)]
fn flush_inner(
    agg: &Aggregator,
    url: &str,
    sample_rate: u64,
    source: &str,
    sender: &dyn Sender,
    last_count: &AtomicU64,
    last_error: &Mutex<Option<String>>,
) -> usize {
    let obs = agg.drain();
    if obs.is_empty() {
        return 0;
    }
    let payload = encode_payload(&obs, sample_rate, source);
    match sender.send(url, payload.as_bytes()) {
        Ok(()) => {
            last_count.store(obs.len() as u64, Ordering::SeqCst);
            *last_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
        Err(e) => {
            tracing::trace!(target: "hayven_trace::flusher", error = %e, "flush failed");
            *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
        }
    }
    obs.len()
}

/// Build the wire payload (hand-rolled JSON).
///
/// Shape (AUTHORITATIVE — the daemon 400s on mismatch):
///
/// ```json
/// {"source":"rust","sample_rate":100,"observations":[
///   {"src":"...","dst":"...","ts":1715789520,"observed":5,"weight":500,"kind":"call"}
/// ]}
/// ```
///
/// `weight == observed * sample_rate` (exact — no rounding). `sample_rate`
/// lives at the envelope level, not per-observation.
pub fn encode_payload(observations: &[Observation], sample_rate: u64, source: &str) -> String {
    let mut s = String::with_capacity(64 + observations.len() * 96);
    s.push_str("{\"source\":");
    push_json_string(&mut s, source);
    s.push_str(",\"sample_rate\":");
    s.push_str(&sample_rate.to_string());
    s.push_str(",\"observations\":[");
    for (i, o) in observations.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"src\":");
        push_json_string(&mut s, &o.src);
        s.push_str(",\"dst\":");
        push_json_string(&mut s, &o.dst);
        s.push_str(",\"ts\":");
        s.push_str(&o.ts.to_string());
        s.push_str(",\"observed\":");
        s.push_str(&o.observed.to_string());
        s.push_str(",\"weight\":");
        // weight = observed * sample_rate, computed here so the daemon's
        // recomputation matches exactly.
        s.push_str(&(o.observed * sample_rate).to_string());
        s.push_str(",\"kind\":");
        push_json_string(&mut s, &o.kind);
        s.push('}');
    }
    s.push_str("]}");
    s
}

/// Append a correctly-escaped JSON string literal (including the quotes).
///
/// Handles the JSON-mandatory escapes: `"`, `\`, control chars `< 0x20`
/// (with the short forms for `\b \t \n \f \r`, else `\u00XX`). This is the
/// only "tricky" part of hand-rolling JSON; entity ids are normally ASCII
/// identifiers but we escape defensively so a weird module path can't produce
/// invalid JSON.
fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0A}' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{0D}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// A mock sender that captures every POST so tests can inspect the body.
    #[derive(Default)]
    struct FakeSender {
        calls: StdMutex<Vec<(String, Vec<u8>)>>,
        error: StdMutex<Option<String>>,
    }

    impl Sender for FakeSender {
        fn send(&self, url: &str, payload: &[u8]) -> Result<(), String> {
            if let Some(e) = self.error.lock().unwrap().clone() {
                return Err(e);
            }
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), payload.to_vec()));
            Ok(())
        }
    }

    fn obs(src: &str, dst: &str, observed: u64) -> Observation {
        Observation {
            src: src.into(),
            dst: dst.into(),
            ts: 1_715_789_520,
            observed,
            kind: "call".into(),
        }
    }

    #[test]
    fn encode_matches_wire_contract_byte_shape() {
        let o = [obs("a::f", "b::g", 5)];
        let body = encode_payload(&o, 100, "rust");
        // Verbatim byte-shape check against the authoritative contract.
        assert_eq!(
            body,
            "{\"source\":\"rust\",\"sample_rate\":100,\"observations\":[\
             {\"src\":\"a::f\",\"dst\":\"b::g\",\"ts\":1715789520,\
             \"observed\":5,\"weight\":500,\"kind\":\"call\"}]}"
        );
    }

    #[test]
    fn weight_equals_observed_times_sample_rate() {
        let o = [obs("alpha", "beta", 7), obs("alpha", "gamma", 3)];
        let body = encode_payload(&o, 50, "rust");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["sample_rate"], 50);
        assert_eq!(v["source"], "rust");
        for ob in v["observations"].as_array().unwrap() {
            let observed = ob["observed"].as_u64().unwrap();
            let weight = ob["weight"].as_u64().unwrap();
            let rate = v["sample_rate"].as_u64().unwrap();
            assert_eq!(weight, observed * rate);
        }
    }

    #[test]
    fn round_trips_back_to_expected_fields() {
        let o = [obs("svc::login", "db::get_user", 4)];
        let body = encode_payload(&o, 100, "rust");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let first = &v["observations"][0];
        assert_eq!(first["src"], "svc::login");
        assert_eq!(first["dst"], "db::get_user");
        assert_eq!(first["ts"], 1_715_789_520u64);
        assert_eq!(first["observed"], 4);
        assert_eq!(first["weight"], 400);
        assert_eq!(first["kind"], "call");
    }

    #[test]
    fn json_strings_are_escaped() {
        let o = [obs("a\"b\\c\n", "d\te", 1)];
        let body = encode_payload(&o, 1, "rust");
        // Must still parse as valid JSON with the original values intact.
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["observations"][0]["src"], "a\"b\\c\n");
        assert_eq!(v["observations"][0]["dst"], "d\te");
    }

    #[test]
    fn flush_once_posts_to_correct_url_and_drains() {
        let agg = Arc::new(Aggregator::new());
        agg.add("a", "b", 1);
        agg.add("a", "b", 1);
        agg.add("a", "c", 1);
        let fake = Arc::new(FakeSender::default());
        let f = Flusher::new(
            agg,
            "http://daemon",
            Duration::from_secs(30),
            10,
            "rust",
            fake.clone(),
        );

        let n = f.flush_once();
        assert_eq!(n, 2); // two distinct edges

        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "http://daemon/api/traces/observations");

        let v: serde_json::Value = serde_json::from_slice(&calls[0].1).unwrap();
        assert_eq!(v["source"], "rust");
        assert_eq!(v["sample_rate"], 10);
        let mut by_edge = std::collections::HashMap::new();
        for ob in v["observations"].as_array().unwrap() {
            by_edge.insert(
                (
                    ob["src"].as_str().unwrap().to_string(),
                    ob["dst"].as_str().unwrap().to_string(),
                ),
                (ob["observed"].as_u64().unwrap(), ob["weight"].as_u64().unwrap()),
            );
        }
        assert_eq!(by_edge[&("a".into(), "b".into())], (2, 20));
        assert_eq!(by_edge[&("a".into(), "c".into())], (1, 10));

        // Drained — a second flush is a no-op.
        drop(calls);
        assert_eq!(f.flush_once(), 0);
    }

    #[test]
    fn flush_once_swallows_sender_errors() {
        let agg = Arc::new(Aggregator::new());
        agg.add("x", "y", 1);
        let fake = Arc::new(FakeSender::default());
        *fake.error.lock().unwrap() = Some("connection refused".to_string());
        let f = Flusher::new(
            agg,
            "http://daemon",
            Duration::from_secs(30),
            100,
            "rust",
            fake.clone(),
        );
        // Must not panic; still reports it drained 1.
        let n = f.flush_once();
        assert_eq!(n, 1);
        assert!(f.last_error().unwrap().contains("connection refused"));
    }

    #[test]
    fn background_flusher_drains_periodically() {
        let agg = Arc::new(Aggregator::new());
        let fake = Arc::new(FakeSender::default());
        let mut f = Flusher::new(
            Arc::clone(&agg),
            "http://daemon",
            Duration::from_millis(20),
            100,
            "rust",
            fake.clone(),
        );
        f.start();
        for _ in 0..50 {
            agg.add("a", "b", 1);
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(120));
        f.stop(true);

        let calls = fake.calls.lock().unwrap();
        assert!(!calls.is_empty(), "expected at least one background flush");
        let mut total_weight = 0u64;
        for (_url, payload) in calls.iter() {
            let v: serde_json::Value = serde_json::from_slice(payload).unwrap();
            for ob in v["observations"].as_array().unwrap() {
                if ob["src"] == "a" && ob["dst"] == "b" {
                    total_weight += ob["weight"].as_u64().unwrap();
                }
            }
        }
        // 50 sampled adds * sample_rate 100 = 5000 reported weight.
        assert_eq!(total_weight, 50 * 100);
    }

    #[test]
    fn stop_without_flush_sends_nothing() {
        let agg = Arc::new(Aggregator::new());
        agg.add("a", "b", 1);
        let fake = Arc::new(FakeSender::default());
        let mut f = Flusher::new(
            Arc::clone(&agg),
            "http://daemon",
            Duration::from_secs(10),
            100,
            "rust",
            fake.clone(),
        );
        f.start();
        f.stop(false);
        assert!(fake.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn parse_http_url_variants() {
        assert_eq!(
            parse_http_url("http://localhost:7777/api/traces/observations").unwrap(),
            ("localhost".into(), 7777, "/api/traces/observations".into())
        );
        assert_eq!(
            parse_http_url("http://example.com").unwrap(),
            ("example.com".into(), 80, "/".into())
        );
        assert!(parse_http_url("https://localhost/x").is_err());
    }
}
