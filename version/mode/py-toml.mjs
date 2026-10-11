import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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

  let inProject = false;
  for (const line of raw.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (section) {
      inProject = section[1] === "project";
      continue;
    }

    if (!inProject) {
      continue;
    }

    const version = /^\s*version\s*=\s*(["'])(\d+)\.(\d+)\.(\d+)(?:[-+][^"']*)?\1\s*(?:#.*)?$/u.exec(line);
    if (version) {
      return {
        major: Number(version[2]),
        minor: Number(version[3]),
      };
    }
  }

  fail(`Could not find [project] version = "X.Y.Z" in '${absolutePath}'`);
}
