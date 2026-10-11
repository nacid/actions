import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const VERSION_RE = /(?<!\d)(?<version>(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/mu;

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

export async function getVersionMajorMinor(versionSource) {
  const absolutePath = resolveWorkspacePath(versionSource);
  let raw;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    fail(`Failed to read '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`);
  }

  const match = VERSION_RE.exec(raw);
  if (!match?.groups) {
    fail(`Could not find an X.Y.Z version in '${absolutePath}'`);
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
  };
}
