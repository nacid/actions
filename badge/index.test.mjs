import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { badgePayload, badgeUrl, DEFAULT_ENDPOINT, updateBadge } from "./index.mjs";

test("custom defaults and fixed preset labels/colors", () => {
  assert.deepEqual(badgePayload({ message: "passed", passed: true }), { label: "build", color: "#28a745", message: "passed" });
  assert.deepEqual(badgePayload({ type: "custom", label: "coverage", color: "#123456", message: "95%", passed: true }), {
    label: "coverage", color: "#123456", message: "95%",
  });
  for (const [type, color] of [
    ["tests", "#28a745"], ["npm", "#007ec6"], ["docker", "#97ca00"],
    ["dev", "#28a745"], ["alpha", "#28a745"], ["beta", "#28a745"], ["release", "#28a745"],
  ]) {
    assert.deepEqual(badgePayload({ type, label: "ignored", color: "ignored", message: "1.2.3", passed: true }), {
      label: type, color, message: "1.2.3",
    });
  }
});

test("passed false forces red for every preset and custom without changing label/message", () => {
  for (const type of ["tests", "npm", "docker", "dev", "alpha", "beta", "release", "custom"]) {
    for (const passed of [false, "false", "FALSE", " False "]) {
      assert.deepEqual(badgePayload({ type, label: "my label", color: "blue", message: "failed", passed }), {
        label: type === "custom" ? "my label" : type,
        color: "#e05d44",
        message: "failed",
      });
    }
  }
});

test("passed is mandatory and accepts only booleans or true/false strings", () => {
  for (const passed of [true, "true", "TRUE", " True "]) {
    assert.equal(badgePayload({ message: "ok", passed }).color, "#28a745");
  }
  for (const passed of [undefined, null, "", " ", 0, 1, "0", "1", "yes", "no", {}, []]) {
    assert.throws(() => badgePayload({ message: "ok", passed }), /Input 'passed'.*true or false/u);
  }
});

test("missing messages, unknown types and oversized JSON fail before sending", () => {
  for (const message of [undefined, "", "  ", 42, null]) {
    assert.throws(() => badgePayload({ message, passed: true }), /message.*required/u);
  }
  for (const type of ["TESTS", "unknown", "toString", "__proto__", ""]) {
    assert.throws(() => badgePayload({ type, message: "ok", passed: true }), /Input 'type'/u);
  }
  assert.throws(() => badgePayload({ message: "ok", label: 42, passed: true }), /must be strings/u);
  assert.throws(() => badgePayload({ message: "x".repeat(16 * 1024), passed: true }), /16 KiB/u);
});

test("endpoint/path joining preserves the base and encodes raw segments", () => {
  assert.equal(badgeUrl(undefined, "project/build.svg"), "https://nacid.me/badge/project/build.svg");
  for (const endpoint of ["https://example.com/badge", "https://example.com/badge/", "https://example.com/badge///"]) {
    assert.equal(badgeUrl(endpoint, "project/build.svg"), "https://example.com/badge/project/build.svg");
  }
  assert.equal(badgeUrl("http://localhost:8080", "сборка/a b.svg"), "http://localhost:8080/%D1%81%D0%B1%D0%BE%D1%80%D0%BA%D0%B0/a%20b.svg");
  assert.equal(badgeUrl("https://example.com/base", "a?b#c.svg"), "https://example.com/base/a%3Fb%23c.svg");
  assert.equal(badgeUrl("https://example.com", "%2e%2e/build.svg"), "https://example.com/%252e%252e/build.svg");
});

test("invalid URLs and paths cannot redirect the write to another origin", () => {
  for (const endpoint of ["bad", "ftp://example.com", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com/#fragment"]) {
    assert.throws(() => badgeUrl(endpoint, "build.svg"), /endpoint/u);
  }
  for (const path of [undefined, "", "  ", "/build.svg", "a/", "a//b", ".", "..", "a/../b", "a\\b", "a\u0000b", "https://evil.example/a", "\ud800", "x".repeat(1024)]) {
    assert.throws(() => badgeUrl(DEFAULT_ENDPOINT, path), /path/u);
  }
});

test("POST uses JSON and omits Authorization when the optional token is absent", async () => {
  let captured;
  let cancelled = false;
  const result = await updateBadge({ path: "project/tests.svg", type: "tests", message: 'passed "✓"\nnext', passed: true }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, body: { cancel: async () => { cancelled = true; } } };
    },
  });
  assert.equal(captured.url, "https://nacid.me/badge/project/tests.svg");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(captured.options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(captured.options.body), { label: "tests", color: "#28a745", message: 'passed "✓"\nnext' });
  assert.equal(captured.options.redirect, "error");
  assert.ok(captured.options.signal instanceof AbortSignal);
  assert.equal(result.url, captured.url);
  assert.ok(cancelled);
});

test("a supplied token is sent as Bearer; malformed tokens are rejected", async () => {
  let header;
  await updateBadge({ endpoint: "https://nacid.me/badge", path: "test.svg", token: "test-token", message: "ok", passed: true }, {
    fetchImpl: async (_url, options) => {
      header = options.headers.Authorization;
      return { ok: true, status: 200 };
    },
  });
  assert.equal(header, "Bearer test-token");
  for (const token of ["line\nbreak", "has space", "кириллица", 123]) {
    await assert.rejects(updateBadge({ path: "test.svg", token, message: "ok", passed: true }), /Input 'token'/u);
  }
});

test("HTTP errors are propagated without reading or logging response bodies", async () => {
  for (const status of [400, 401, 403, 413, 500, 503]) {
    let cancelled = false;
    await assert.rejects(updateBadge({ path: "test.svg", message: "ok", passed: true }, {
      fetchImpl: async () => ({
        ok: false, status,
        text: () => { throw new Error("Response body must not be read"); },
        body: { cancel: async () => { cancelled = true; } },
      }),
    }), new RegExp(`HTTP ${status}`, "u"));
    assert.ok(cancelled);
  }
});

test("network failures and timeouts have safe messages and no retries", async () => {
  let attempts = 0;
  await assert.rejects(updateBadge({ path: "test.svg", token: "secret-value", message: "ok", passed: true }, {
    fetchImpl: async () => { attempts++; throw new Error("Error containing secret-value"); },
  }), { message: "Badge update request failed (network, TLS, or redirect error)" });
  assert.equal(attempts, 1);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(updateBadge({ path: "test.svg", message: "ok", passed: true }, {
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }), { message: "Badge update timed out" });
  } finally {
    clearTimeout(keepAlive);
  }
});

async function httpFixture(t) {
  const requests = [];
  let status = 200;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(status, status === 302 ? { Location: "/must-not-follow" } : { "Content-Type": "image/svg+xml" });
      res.end(status === 200 ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : "not printed");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/badge`, setStatus: value => { status = value; } };
}

test("real HTTP POST sends escaped JSON to the chosen path and never follows redirects", async t => {
  const app = await httpFixture(t);
  await updateBadge({ endpoint: app.endpoint, path: "project/build.svg", message: 'version "2.0"', token: "test-token", passed: true });
  assert.equal(app.requests[0].path, "/badge/project/build.svg");
  assert.equal(app.requests[0].method, "POST");
  assert.equal(app.requests[0].headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(app.requests[0].body), { label: "build", color: "#28a745", message: 'version "2.0"' });
  app.setStatus(302);
  await assert.rejects(updateBadge({ endpoint: app.endpoint, path: "redirect.svg", message: "ok", token: "test-token", passed: true }), /redirect error/u);
  assert.equal(app.requests.length, 2);
});

function childAction(entry, overrides = {}) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("INPUT_")));
    Object.assign(env, overrides);
    const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("the action entry point reads runner inputs directly and through a linked action directory", async t => {
  const app = await httpFixture(t);
  const dir = await mkdtemp(join(tmpdir(), "badge-action-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const linked = join(dir, "action");
  await symlink(fileURLToPath(new URL(".", import.meta.url)), linked, process.platform === "win32" ? "junction" : "dir");
  for (const entry of [fileURLToPath(new URL("./index.mjs", import.meta.url)), join(linked, "index.mjs")]) {
    const result = await childAction(entry, {
      INPUT_ENDPOINT: app.endpoint, INPUT_PATH: "project/docker.svg", INPUT_TYPE: "docker",
      INPUT_MESSAGE: "  1.2.3  ", INPUT_PASSED: "true", INPUT_TOKEN: "test-token", INPUT_LABEL: "ignored", INPUT_COLOR: "ignored",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /::add-mask::test-token/u);
    assert.doesNotMatch(result.stdout.replace("::add-mask::test-token", ""), /test-token/u);
    assert.match(result.stdout, /Updated badge:/u);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(app.requests.at(-1).body), { label: "docker", color: "#97ca00", message: "1.2.3" });
  }
});

test("CLI defaults are applied without runner-provided defaults and token is optional", async t => {
  const app = await httpFixture(t);
  const result = await childAction(fileURLToPath(new URL("./index.mjs", import.meta.url)), {
    INPUT_ENDPOINT: app.endpoint, INPUT_PATH: "custom.svg", INPUT_MESSAGE: "ok", INPUT_PASSED: "true",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(app.requests[0].headers.authorization, undefined);
  assert.deepEqual(JSON.parse(app.requests[0].body), { label: "build", color: "#28a745", message: "ok" });
});

test("CLI false is parsed as false and missing/invalid passed never sends a POST", async t => {
  const app = await httpFixture(t);
  const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));
  const inputs = { INPUT_ENDPOINT: app.endpoint, INPUT_PATH: "tests.svg", INPUT_MESSAGE: "failed", INPUT_TYPE: "tests" };
  const failed = await childAction(entry, { ...inputs, INPUT_PASSED: "false" });
  assert.equal(failed.code, 0, failed.stderr);
  assert.deepEqual(JSON.parse(app.requests[0].body), { label: "tests", color: "#e05d44", message: "failed" });
  for (const passed of [undefined, "", "yes", "0"]) {
    const env = { ...inputs };
    if (passed !== undefined) env.INPUT_PASSED = passed;
    const result = await childAction(entry, env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Input 'passed'.*true or false/u);
  }
  assert.equal(app.requests.length, 1);
});

test("CLI failures produce a failed step and safe diagnostics", async t => {
  const app = await httpFixture(t);
  const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));
  const missing = await childAction(entry, { INPUT_MESSAGE: "ok" });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Input 'path' is required/u);
  assert.equal(app.requests.length, 0);
  app.setStatus(401);
  const unauthorized = await childAction(entry, { INPUT_ENDPOINT: app.endpoint, INPUT_PATH: "test.svg", INPUT_MESSAGE: "ok", INPUT_PASSED: "true" });
  assert.equal(unauthorized.code, 1);
  assert.match(unauthorized.stderr, /HTTP 401/u);
  assert.doesNotMatch(unauthorized.stderr, /not printed/u);
});
