import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ENDPOINT = "https://nacid.me/badge";
export const DEFAULT_COLOR = "#28a745";
export const PRESETS = Object.freeze({
  tests: Object.freeze({ label: "tests", color: "#800020" }),
  npm: Object.freeze({ label: "npm", color: "#007ec6" }),
  docker: Object.freeze({ label: "docker", color: "#97ca00" }),
  dev: Object.freeze({ label: "dev", color: DEFAULT_COLOR }),
  alpha: Object.freeze({ label: "alpha", color: DEFAULT_COLOR }),
  beta: Object.freeze({ label: "beta", color: DEFAULT_COLOR }),
  release: Object.freeze({ label: "release", color: DEFAULT_COLOR }),
});

function readInput(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

function parsePassed(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error("Input 'passed' is required and must be true or false");
}

export function badgePayload({ type = "custom", label = "build", color = DEFAULT_COLOR, message, passed }) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Input 'message' is required");
  }
  const didPass = parsePassed(passed);
  let format;
  if (type === "custom") {
    if (typeof label !== "string" || typeof color !== "string") {
      throw new Error("Inputs 'label' and 'color' must be strings");
    }
    format = { label, color };
  } else if (Object.hasOwn(PRESETS, type)) {
    format = PRESETS[type];
  } else {
    throw new Error("Input 'type' must be tests, npm, docker, dev, alpha, beta, release, or custom");
  }
  const payload = { ...format, color: didPass ? format.color : "#e05d44", message };
  if (Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024) {
    throw new Error("Badge JSON exceeds the service limit of 16 KiB");
  }
  return payload;
}

export function badgeUrl(endpoint = DEFAULT_ENDPOINT, path) {
  let base;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error("Input 'endpoint' must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Input 'endpoint' must be an HTTP(S) URL without credentials, query, or fragment");
  }
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("Input 'path' is required");
  }
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")
    || /[\\\u0000-\u001f\u007f]/u.test(path)
    || Buffer.byteLength(`/${path}`) > 1024) {
    throw new Error("Input 'path' must be a relative badge path with no empty or dot segments (maximum 1024 UTF-8 bytes including leading slash)");
  }
  let encoded;
  try {
    encoded = segments.map(encodeURIComponent).join("/");
  } catch {
    throw new Error("Input 'path' contains invalid Unicode");
  }
  return `${base.href.replace(/\/+$/u, "")}/${encoded}`;
}

export async function updateBadge(inputs, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const url = badgeUrl(inputs.endpoint, inputs.path);
  const payload = badgePayload(inputs);
  const token = inputs.token ?? "";
  if (typeof token !== "string" || (token && !/^[\x21-\x7e]+$/u.test(token))) {
    throw new Error("Input 'token' must contain non-whitespace ASCII characters");
  }
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Do not echo transport errors: they can contain URLs or credentials.
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new Error(timeout ? "Badge update timed out" : "Badge update request failed (network, TLS, or redirect error)");
  }
  // The SVG is already stored by the service; do not log or buffer its body.
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Badge update failed with HTTP ${response.status}`);
  return { url, payload };
}

export async function runAction() {
  const token = readInput("token");
  if (token) {
    const escaped = token.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::add-mask::${escaped}`);
  }
  const result = await updateBadge({
    endpoint: readInput("endpoint") || DEFAULT_ENDPOINT,
    path: readInput("path"),
    token,
    type: readInput("type") || "custom",
    color: readInput("color") || DEFAULT_COLOR,
    label: readInput("label") || "build",
    message: readInput("message"),
    passed: readInput("passed"),
  });
  console.log(`Updated badge: ${result.url}`);
  return result;
}

const directRun = process.argv[1]
  && await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url));
if (directRun) {
  try {
    await runAction();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
