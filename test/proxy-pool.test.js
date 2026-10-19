// test/proxy-pool.test.js — offline, deterministic probes for proxy-pool.js

const assert = require("node:assert");
const { test, describe, beforeEach, afterEach } = require("bun:test");
const { createProxyPool, parseProxyUrl, classifyProxy, redactUrl } = require("../proxy-pool");

describe("parseProxyUrl", () => {
  test("accepts and re-parses http url with creds", () => {
    const p = parseProxyUrl("http://alice:secret@127.0.0.1:18097");
    assert.equal(p.ok, true);
    assert.equal(p.url.protocol, "http:");
    assert.equal(p.url.username, "alice");
    assert.equal(p.url.password, "secret");
    assert.equal(p.url.hostname, "127.0.0.1");
    assert.equal(p.url.port, "18097");
  });

  test("accepts https without port (defaults to 443 later)", () => {
    const p = parseProxyUrl("https://proxy.corp.example");
    assert.equal(p.ok, true);
    assert.equal(p.url.port, "");
  });

  test("rejects garbage", () => {
    assert.equal(parseProxyUrl("").ok, false);
    assert.equal(parseProxyUrl("not a url").ok, false);
    assert.equal(parseProxyUrl(null).ok, false);
  });
});

describe("classifyProxy", () => {
  test("http scheme -> http", () => {
    assert.equal(classifyProxy(new URL("http://h:1")), "http");
    assert.equal(classifyProxy(new URL("https://h")), "http");
  });
  test("socks schemes classified distinctly (Bun rejects them on its own)", () => {
    assert.equal(classifyProxy(new URL("socks5://h:1")), "socks5");
    assert.equal(classifyProxy(new URL("socks5h://h:1")), "socks5h");
    assert.equal(classifyProxy(new URL("socks4://h:1")), "socks4");
  });
});

describe("redactUrl", () => {
  test("hides username and password", () => {
    const r = redactUrl(new URL("http://alice:secret@127.0.0.1:18097"));
    assert.ok(r.includes("user:***@"), r);
    assert.ok(!r.includes("alice"), r);
    assert.ok(!r.includes("secret"), r);
  });
  test("keeps no-cred URL plainly readable", () => {
    assert.equal(redactUrl(new URL("http://127.0.0.1:18097")), "http://127.0.0.1:18097");
  });
});

describe("createProxyPool", () => {
  test("empty/whitespace list -> zero entries and no proxy option", () => {
    const pool = createProxyPool("  ,  ,");
    assert.equal(pool.entries.length, 0);
    assert.equal(pool.nextProxy(), null);
    assert.equal(pool.stats().enabled, false);
  });

  test("http entries are retained, socks entries skipped with reason", () => {
    const pool = createProxyPool(
      "http://a:1, socks5://b:2, socks5h://c:3, https://d:4, socks4://e:5"
    );
    assert.equal(pool.entries.length, 2); // a:1 and d:4
    assert.equal(pool.entries[0].url.hostname, "a");
    assert.equal(pool.entries[1].url.hostname, "d");
    assert.equal(pool.skipped.length, 3);
    const kinds = pool.skipped.map((s) => s.kind).sort();
    assert.deepEqual(kinds, ["socks4", "socks5", "socks5h"]);
    // Every skipped entry must tell the operator HOW Bun refused it.
    for (const s of pool.skipped) {
      assert.match(s.reason, /Bun 1\.4 fetch only tunnels/);
    }
  });

  test("skipped socks URLs are redacted (no credentials leaked)", () => {
    const pool = createProxyPool("socks5://alice:secret@127.0.0.1:9");
    assert.equal(pool.skipped.length, 1);
    const shown = pool.skipped[0].raw;
    assert.ok(!shown.includes("alice") && !shown.includes("secret"), shown);
  });

  test("duplicate entries dropped", () => {
    const pool = createProxyPool("http://a:1, http://a:1, http://b:2");
    assert.equal(pool.entries.length, 2);
  });

  test("round-robin visits every live entry before repeating", () => {
    const pool = createProxyPool("http://a:1, http://b:2, http://c:3");
    const order = [];
    for (let i = 0; i < 6; i++) order.push(pool.nextProxy().url.hostname);
    assert.deepEqual(order, ["a", "b", "c", "a", "b", "c"]);
  });

  test("consecutive failures bounce an entry past the cooldown window", () => {
    const pool = createProxyPool("http://a:1, http://b:2");
    const target = pool.entries.find((e) => e.url.hostname === "a");
    for (let i = 0; i < 3; i++) pool.markBad(target, new Error("ECONNREFUSED"));
    assert.ok(target.bouncedUntil > Date.now());
    // nextProxy must skip it; with only one healthy entry it always returns b
    const seen = new Set();
    for (let i = 0; i < 5; i++) seen.add(pool.nextProxy().url.hostname);
    assert.deepEqual([...seen], ["b"]);
    const stats = pool.stats();
    assert.equal(stats.entry.find((e) => e.redacted.includes("a:1")).bounced, true);
  });

  test("clearing failures un-bounces a proxy (good resets streak)", () => {
    const pool = createProxyPool("http://a:1, http://b:2");
    const target = pool.entries.find((e) => e.url.hostname === "a");
    for (let i = 0; i < 3; i++) pool.markBad(target, new Error("ETIMEDOUT"));
    pool.markGood(target);
    assert.equal(target.bouncedUntil, 0);
    assert.equal(target.consecutiveBad, 0);
    const seen = new Set();
    for (let i = 0; i < 6; i++) seen.add(pool.nextProxy().url.hostname);
    assert.deepEqual([...seen].sort(), ["a", "b"]);
  });

  test("everything bounced -> isLive=false and nextProxy=null", () => {
    const pool = createProxyPool("http://a:1, http://b:2");
    for (const e of pool.entries) for (let i = 0; i < 3; i++) pool.markBad(e, new Error("x"));
    assert.equal(pool.isLive(), false);
    assert.equal(pool.nextProxy(), null);
  });

  test("bounced entries snap back once the cooldown window has passed", () => {
    const pool = createProxyPool("http://a:1");
    const e = pool.entries[0];
    for (let i = 0; i < 3; i++) pool.markBad(e, new Error("x"));
    e.bouncedUntil = Date.now() - 1; // simulate cooldown expiry
    assert.equal(pool.isLive(), true);
    assert.equal(pool.nextProxy().url.hostname, "a");
  });
});
