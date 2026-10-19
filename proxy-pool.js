#!/usr/bin/env bun
/**
 * proxy-pool.js — outbound egress proxy pool for opencode-free-bridge.
 *
 * Feed it a comma-separated list of proxy URLs (env `PROXY_POOLS`; the Docker
 * compose file maps a YAML array onto that string). It hands every upstream
 * `fetch()` an extra `{ proxy }` option — Bun's own extension — and rotates
 * through the pool, so a failing proxy is skipped for the following requests.
 *
 * What Bun 1.4 supports (measured against live servers, not the docs):
 *   `http://` and `https://` proxy schemes, including `user:pass@` — Bun opens
 *   a CONNECT tunnel for https targets and forwards the request line for
 *   http targets. Everything else (`socks5://`, `socks5h://`, `socks4://`,
 *   `socks5+加密://`, …) throws `UnsupportedProxyProtocol` upstream
 *   (oven-sh/bun#16812). This pool therefore *classifies on parse*: socks
 *   URLs are kept, counted, and surfaced in `poolStats()` so an operator can
 *   see what is actually dialable, but the proxy option Bun itself cannot
 *   honor is never attached to a request (it would kill the request before
 *   it ever left the bridge).
 *
 * Nothing here reads upstream headers or fingerprints; this is pure egress
 * plumbing and stays out of the gate-identity chain.
 *
 * Zero external dependencies.
 */

const PROXY_BOUNCE_AFTER = parseInt(process.env.PROXY_BOUNCE_AFTER || "3", 10);
const PROXY_BOUNCE_COOLDOWN_MS = parseInt(
  process.env.PROXY_BOUNCE_COOLDOWN_MS || String(300 * 1000),
  10
);

/**
 * Parse one proxy URL into `{ ok, reason }`:
 *   - scheme must be http:// or https:// (Bun 1.4 fetch canot CONNECT
 *     through anything else — socks is unsupported upstream)
 *   - host is required; port defaults to 443 for https and 80 for http
 *   - credentials are allowed and forwarded inside the same URL
 */
function parseProxyUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "empty" };
  let u;
  try {
    u = new URL(raw.trim());
  } catch (e) {
    return { ok: false, reason: `unparseable: ${e.message}` };
  }
  return { ok: true, url: u };
}

/**
 * A URL that Bun's fetch can actually tunnel through.
 */
function isBunSupported(u) {
  const scheme = (u.protocol || "").toLowerCase();
  return scheme === "http:" || scheme === "https:";
}

/**
 * Classify what kind of pool entry this is, for operator visibility.
 */
function classifyProxy(u) {
  const scheme = (u.protocol || "").toLowerCase();
  if (scheme === "http:" || scheme === "https:") return "http";
  if (scheme.startsWith("socks5h")) return "socks5h";
  if (scheme.startsWith("socks5")) return "socks5";
  if (scheme.startsWith("socks4")) return "socks4";
  return `unsupported-scheme:${scheme.replace(/:$/, "")}`;
}

function redactUrl(u) {
  const host = u.hostname;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const creds = u.username || u.password ? "user:***@" : "";
  const scheme = u.protocol.replace(/:$/, "");
  return `${scheme}://${creds}${host}:${port}`;
}

/**
 * The pool itself. One instance per process; `wire()` re-exports its members
 * to whoever asked for them.
 */
function createProxyPool(rawList) {
  const entries = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of String(rawList || "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    if (seen.has(value)) continue; // de-dup
    seen.add(value);
    const p = parseProxyUrl(value);
    if (!p.ok) {
      skipped.push({ raw: value, kind: "invalid", reason: p.reason, redacted: value });
      continue;
    }
    if (!isBunSupported(p.url)) {
      skipped.push({ raw: redactUrl(p.url), kind: classifyProxy(p.url), reason: "Bun 1.4 fetch only tunnels http:// or https:// proxies (socks upstream: oven-sh/bun#16812)" });
      continue;
    }
    entries.push({
      url: p.url,
      redacted: redactUrl(p.url),
      good: 0,
      bad: 0,
      consecutiveBad: 0,
      bouncedUntil: 0,
      lastError: null,
    });
  }

  let cursor = -1; // round-robin over `entries`

  function nextProxy() {
    if (entries.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < entries.length; i++) {
      cursor = (cursor + 1) % entries.length;
      const candidate = entries[cursor];
      if (candidate.bouncedUntil > now) continue;
      return candidate;
    }
    return null; // every proxy has bounced
  }

  function markGood(entry) {
    if (!entry) return;
    entry.good++;
    entry.consecutiveBad = 0;
    entry.bouncedUntil = 0;
    entry.lastError = null;
  }

  function markBad(entry, err) {
    if (!entry) return;
    entry.bad++;
    entry.consecutiveBad++;
    const message = err instanceof Error ? err.message : String(err || "error");
    entry.lastError = message;
    if (entry.consecutiveBad >= PROXY_BOUNCE_AFTER) {
      entry.bouncedUntil = Date.now() + PROXY_BOUNCE_COOLDOWN_MS;
      console.warn(
        `[proxy-pool] ${entry.redacted} bounced for ${Math.round(PROXY_BOUNCE_COOLDOWN_MS / 1000)}s after ${entry.consecutiveBad} consecutive failures (last: ${message})`
      );
      entry.consecutiveBad = 0;
    }
  }

  function stats() {
    const now = Date.now();
    return {
      enabled: entries.length > 0,
      size: entries.length,
      visited: entries.length,
      skipped: skipped.slice(),
      entry: entries.map((e) => ({
        redacted: e.redacted,
        good: e.good,
        bad: e.bad,
        bounced: e.bouncedUntil > now,
        bounceFor: e.bouncedUntil > now ? Math.round((e.bouncedUntil - now) / 1000) : 0,
        lastError: e.lastError,
      })),
    };
  }

  function isLive() {
    const now = Date.now();
    return entries.some((e) => e.bouncedUntil <= now);
  }

  return {
    entries,
    skipped,
    nextProxy,
    markGood,
    markBad,
    stats,
    isLive,
  };
}

// Single shared pool; server.js + identity.js + verify.js all attach through
// this so a rotate decision is a process-wide fact.
const POOL = createProxyPool(process.env.PROXY_POOLS || "");

/**
 * Build the `{ proxy: URL-string }` option Bun's fetch greps for, or `null`
 * when the pool is empty / entirely bounced. Only http(s) URLs ever get here,
 * so the caller does not have to re-filter.
 */
function proxyFetchOption() {
  const entry = POOL.nextProxy();
  if (!entry) return null;
  return { entry, init: { proxy: entry.url.href } };
}

/** The `init` fragment to merge, or `undefined` when no proxy is in play. */
function proxyOptionInit() {
  const chosen = proxyFetchOption();
  return chosen ? chosen.init : undefined;
}

/**
 * Failure accounting for fetch call sites: the option helper only builds the
 * init object and cannot see the outcome, so a caller that wants the pool to
 * learn (bounce dead proxies, clear streaks on success) reports back here.
 * Passing `null`/`undefined` is a no-op, so callers can forward blindly.
 */
function reportProxyOutcome(outcome) {
  if (!outcome || !outcome.entry) return;
  if (outcome.ok) POOL.markGood(outcome.entry);
  else POOL.markBad(outcome.entry, outcome.error);
}

module.exports = {
  createProxyPool,
  proxyPool: POOL,
  proxyFetchOption,
  proxyOptionInit,
  reportProxyOutcome,
  parseProxyUrl,
  classifyProxy,
  redactUrl,
};
