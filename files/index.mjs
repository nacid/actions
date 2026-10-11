import { randomUUID } from "node:crypto";
import { appendFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function readInput(name) {
  const key = name.toUpperCase();
  return (process.env[`INPUT_${key}`] ?? process.env[`INPUT_${key.replaceAll("-", "_")}`] ?? "").trim();
}

async function existing(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function segmentMatcher(segment) {
  let expression = "";
  for (const character of segment) {
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${expression}$(?!.)`, "su");
}

export async function findFiles({ pattern, minimum = 1, workingDirectory = ".", workspace = process.env.GITHUB_WORKSPACE || process.cwd() }) {
  if (!pattern?.trim()) {
    throw new Error("Input 'pattern' is required");
  }
  const minimumCount = Number(minimum);
  if (!/^\d+$/u.test(String(minimum)) || !Number.isSafeInteger(minimumCount)) {
    throw new Error("Input 'minimum' must be a non-negative safe integer");
  }
  const cwd = resolve(workspace, workingDirectory);
  const directory = await stat(cwd);
  if (!directory.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${cwd}`);
  }

  const absolutePattern = resolve(cwd, pattern.replaceAll("\\", "/"));
  const { root } = parse(absolutePattern);
  const segments = absolutePattern.slice(root.length).split(sep).filter(Boolean);
  const matchers = segments.map(segmentMatcher);
  const matches = new Set();
  const visited = new Set();

  async function visit(path, index) {
    const key = JSON.stringify([path, index]);
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    if (index === segments.length) {
      const file = await existing(() => stat(path));
      if (file?.isFile()) {
        matches.add(path);
      }
      return;
    }

    const segment = segments[index];
    if (!segment.includes("*") && !segment.includes("?")) {
      await visit(join(path, segment), index + 1);
      return;
    }
    if (segment === "**") {
      await visit(path, index + 1);
    }
    const entries = await existing(() => readdir(path, { withFileTypes: true }));
    for (const entry of entries ?? []) {
      if (segment === "**") {
        if (entry.isDirectory() || index === segments.length - 1) {
          // Do not recurse into directory symlinks, which can create cycles.
          await visit(join(path, entry.name), entry.isDirectory() ? index : index + 1);
        }
      } else if (matchers[index].test(entry.name)) {
        await visit(join(path, entry.name), index + 1);
      }
    }
  }

  await visit(root, 0);
  const names = [...matches].sort().map((path) => basename(path));
  if (names.length < minimumCount) {
    throw new Error(`Found ${names.length} files matching '${pattern}', but minimum is ${minimumCount}`);
  }
  return {
    first: names[0] ?? "",
    last: names.at(-1) ?? "",
    all: names.join(","),
    count: names.length,
  };
}

export async function runAction() {
  const outputs = await findFiles({
    pattern: readInput("pattern"),
    minimum: readInput("minimum") || "1",
    workingDirectory: readInput("working-directory") || ".",
  });
  if (process.env.GITHUB_OUTPUT) {
    const content = Object.entries(outputs).map(([name, value]) => {
      const delimiter = `files_${randomUUID()}`;
      return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
    }).join("");
    await appendFile(process.env.GITHUB_OUTPUT, content, "utf8");
  }
  console.log(`Found ${outputs.count} matching files`);
  return outputs;
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
