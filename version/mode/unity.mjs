import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const BUNDLE_VERSION_RE = /^\s*bundleVersion:\s*(?<version>\S.*?)\s*$/mu;

function fail(message) {
  throw new Error(message);
}

function resolveWorkspacePath(filePath) {
  const trimmed = (filePath ?? "").trim();
  if (!trimmed) {
    fail("Expected a non-empty version source");
  }

  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

function unquote(value) {
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' || first === "'") && last === first ? value.slice(1, -1) : value;
}

export async function getVersionMajorMinor(versionSource) {
  const absolutePath = resolveWorkspacePath(versionSource);
  let raw;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    fail(`Failed to read '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`);
  }

  const match = BUNDLE_VERSION_RE.exec(raw);
  if (!match) {
    fail(`Field 'bundleVersion' is missing in '${absolutePath}'`);
  }

  const version = unquote((match.groups?.version ?? "").trim());
  const versionMatch = VERSION_RE.exec(version);
  if (!versionMatch) {
    fail(`Unity bundleVersion '${version}' is invalid, expected X.Y.Z or X.Y.Z-suffix`);
  }

  return {
    major: Number(versionMatch[1]),
    minor: Number(versionMatch[2]),
  };
}
