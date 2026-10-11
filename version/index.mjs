import { appendFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TAG_PREFIX = "version/";
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_TYPE_RE = /^[A-Z][A-Z0-9_]*$/;

function fail(message) {
  throw new Error(message);
}

export function readActionInput(name) {
  const normalized = name.trim().replaceAll(" ", "_").toUpperCase();
  const canonical = process.env[`INPUT_${normalized}`];
  const underscoreAlias = process.env[`INPUT_${normalized.replaceAll("-", "_")}`];
  return (canonical ?? underscoreAlias ?? "").trim();
}

function readStringInput(name, legacyEnv, fallback = "") {
  return readActionInput(name) || (process.env[legacyEnv] ?? "").trim() || fallback;
}

function readNumberInput(name, legacyEnv, fallback) {
  const raw = readStringInput(name, legacyEnv);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fail(`Input '${name}' must be a number, got: ${raw}`);
  }

  return value;
}

export function parseBooleanInput(name, value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  fail(`Input '${name}' must be 'true' or 'false', got: ${value}`);
}

function run(command, args, { check = true, cwd = process.cwd(), env = process.env } = {}) {
  console.log(`+ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
  });

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (check && result.status !== 0) {
    fail(`Command failed (${command} ${args.join(" ")}):\n${output}`);
  }

  return {
    status: result.status ?? 1,
    output,
  };
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).output;
}

function gitLines(cwd, ...args) {
  const output = git(cwd, ...args);
  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function ensureTagsFetched(cwd, authEnvironment) {
  run("git", ["fetch", "origin", "--tags", "--force"], { cwd, env: authEnvironment });
}

function headSha(cwd) {
  return git(cwd, "rev-parse", "HEAD");
}

function listAllTags(cwd) {
  return gitLines(cwd, "tag", "-l");
}

function deleteLocalTag(cwd, tag) {
  const { status } = run("git", ["show-ref", "--tags", "--verify", `refs/tags/${tag}`], { check: false, cwd });
  if (status === 0) {
    run("git", ["tag", "-d", tag], { cwd });
  }
}

function createLightweightTag(cwd, tag, sha) {
  deleteLocalTag(cwd, tag);
  run("git", ["tag", tag, sha], { cwd });
}

function pushVersionTag(cwd, tag, authEnvironment) {
  return run("git", ["push", "origin", tag], { check: false, cwd, env: authEnvironment });
}

function appendGitConfigEnvironment(baseEnvironment, entries) {
  const environment = { ...baseEnvironment };
  const rawCount = (environment.GIT_CONFIG_COUNT ?? "0").trim();
  const existingCount = Number(rawCount);
  if (!Number.isInteger(existingCount) || existingCount < 0) {
    fail(`GIT_CONFIG_COUNT must be a non-negative integer, got: ${rawCount}`);
  }

  entries.forEach(({ key, value }, offset) => {
    const index = existingCount + offset;
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  environment.GIT_CONFIG_COUNT = String(existingCount + entries.length);
  return environment;
}

export function buildGitAuthEnvironment(token, remoteUrl, baseEnvironment = process.env) {
  const normalizedUrl = (remoteUrl ?? "").trim();
  if (!normalizedUrl) {
    fail("Expected a non-empty origin URL");
  }

  const environment = {
    ...baseEnvironment,
    GIT_TERMINAL_PROMPT: "0",
  };
  const scpLikeSsh = /^[^@/:\s]+@[^/:\s]+:.+$/u;
  if (
    isAbsolute(normalizedUrl)
    || /^file:\/\//iu.test(normalizedUrl)
    || /^ssh:\/\//iu.test(normalizedUrl)
    || (!normalizedUrl.includes("://") && scpLikeSsh.test(normalizedUrl))
  ) {
    return environment;
  }
  if (!/^https?:\/\//iu.test(normalizedUrl)) {
    fail(`Origin URL '${normalizedUrl}' must use HTTP(S), SSH, or a local path`);
  }

  const normalizedToken = (token ?? "").trim();
  if (!normalizedToken) {
    fail("Expected a non-empty token for an HTTP(S) origin");
  }

  const credentials = Buffer.from(`x-access-token:${normalizedToken}`, "utf8").toString("base64");
  const key = `http.${normalizedUrl}.extraHeader`;
  return appendGitConfigEnvironment(environment, [
    { key, value: "" },
    { key, value: `AUTHORIZATION: basic ${credentials}` },
  ]);
}

function shouldRetryPush(output) {
  const normalized = output.toLowerCase();
  const needles = [
    "already exists",
    "failed to push some refs",
    "remote rejected",
    "http 5",
    "tls",
    "connection",
    "timed out",
    "the requested url returned error",
  ];

  return needles.some((needle) => normalized.includes(needle));
}

async function sleep(seconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
}

function normalizeVersionType(versionType) {
  const normalized = (versionType ?? "").trim().toUpperCase();
  if (!normalized) {
    fail("Expected a non-empty version type");
  }
  if (!VERSION_TYPE_RE.test(normalized)) {
    fail(`Invalid version type '${versionType}'`);
  }

  return normalized;
}

function handlerFileName(versionType) {
  return `${versionType.toLowerCase().replaceAll("_", "-")}.mjs`;
}

function handlerRelativePath(versionType) {
  return `mode/${handlerFileName(versionType)}`;
}

export async function getVersionMajorMinor(versionType, versionSource, workingDirectory = process.cwd()) {
  const normalizedType = normalizeVersionType(versionType);
  const relativePath = handlerRelativePath(normalizedType);
  const moduleUrl = new URL(`./${relativePath}`, import.meta.url);

  let handler;
  try {
    handler = await import(moduleUrl);
  } catch (error) {
    if (error instanceof Error && error.code === "ERR_MODULE_NOT_FOUND") {
      fail(`Unsupported version type '${normalizedType}': handler '${relativePath}' was not found`);
    }
    throw error;
  }

  if (typeof handler.getVersionMajorMinor !== "function") {
    fail(`Version handler '${relativePath}' must export getVersionMajorMinor(source)`);
  }

  const normalizedSource = (versionSource ?? "").trim();
  if (!normalizedSource) {
    fail("Expected a non-empty version source");
  }
  const sourcePath = isAbsolute(normalizedSource)
    ? resolve(normalizedSource)
    : resolve(workingDirectory, normalizedSource);
  return handler.getVersionMajorMinor(sourcePath);
}

export function resolveWorkingDirectory(
  directory,
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
) {
  const normalized = (directory ?? "").trim() || ".";
  return isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
}

async function requireDirectory(path) {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    fail(`Working directory '${path}' is not accessible: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!details.isDirectory()) {
    fail(`Working directory '${path}' is not a directory`);
  }
}

function matchVersionTag(tag, prefix) {
  return tag.startsWith(prefix) ? SEMVER_RE.exec(tag.slice(prefix.length)) : null;
}

export function computeVersionTag(major, minor, tags, prefix = DEFAULT_TAG_PREFIX) {
  const numbers = tags
    .map((tag) => matchVersionTag(tag, prefix))
    .filter((match) => match && Number(match[1]) === major && Number(match[2]) === minor)
    .map((match) => Number(match[3]));
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 0;
  return `${prefix}${major}.${minor}.${next}`;
}

export function findExistingVersionTag(tags, prefix = DEFAULT_TAG_PREFIX) {
  const matches = tags
    .map((tag) => ({ tag, match: matchVersionTag(tag, prefix) }))
    .filter(({ match }) => match)
    .sort((left, right) => {
      for (let index = 1; index <= 3; index += 1) {
        const difference = Number(right.match[index]) - Number(left.match[index]);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    });
  return matches[0]?.tag;
}

async function writeGithubOutput(name, value) {
  const outputPath = (process.env.GITHUB_OUTPUT ?? "").trim();
  if (!outputPath) {
    return;
  }

  await appendFile(outputPath, `${name}=${value}\n`, "utf8");
}

export function versionDetailsFromTag(versionTag, prefix = DEFAULT_TAG_PREFIX) {
  const match = matchVersionTag(versionTag, prefix);
  if (!match) {
    fail(`Invalid version tag: ${versionTag}`);
  }

  const versionMajor = Number(match[1]);
  const versionMinor = Number(match[2]);
  const versionPatch = Number(match[3]);
  const versionCode = versionMajor * 1_000_000 + versionMinor * 1_000 + versionPatch;
  if (!Number.isSafeInteger(versionCode)) {
    fail(`Version code for '${versionTag}' exceeds the safe integer range`);
  }

  return {
    version: `${versionMajor}.${versionMinor}.${versionPatch}`,
    versionMajor,
    versionMinor,
    versionPatch,
    versionCode,
  };
}

export async function tagVersion({
  workingDirectory = readStringInput("working-directory", "VERSION_WORKING_DIRECTORY", "."),
  token = process.env.FORGEJO_TOKEN,
  retries = readNumberInput("retries", "TAG_RETRIES", 3),
  retrySleep = readNumberInput("retry-sleep", "TAG_RETRY_SLEEP", 1),
  versionType = readStringInput("version-type", "VERSION_TYPE"),
  versionSource = readStringInput("version-source", "VERSION_SOURCE"),
  prefix = readActionInput("prefix") || DEFAULT_TAG_PREFIX,
  pushTag = readActionInput("push-tag"),
} = {}) {
  const shouldPushTag = parseBooleanInput("push-tag", pushTag, true);
  if (!Number.isInteger(retries) || retries < 1) {
    fail(`Tag retries must be a positive integer, got: ${retries}`);
  }
  if (!Number.isFinite(retrySleep) || retrySleep < 0) {
    fail(`Tag retry sleep must be a non-negative number, got: ${retrySleep}`);
  }

  const cwd = resolveWorkingDirectory(workingDirectory);
  await requireDirectory(cwd);
  run("git", ["check-ref-format", `refs/tags/${prefix}0.0.0`], { cwd });
  const originUrl = git(cwd, "remote", "get-url", "origin");
  const authEnvironment = buildGitAuthEnvironment(token, originUrl);
  ensureTagsFetched(cwd, authEnvironment);

  const sha = headSha(cwd);
  console.log(`HEAD: ${sha}`);

  let versionTag = findExistingVersionTag(gitLines(cwd, "tag", "--points-at", sha), prefix);
  if (versionTag) {
    console.log(`HEAD already has version tag: ${versionTag}`);
  } else {
    const { major, minor } = await getVersionMajorMinor(versionType, versionSource, cwd);
    console.log(`major.minor: ${major}.${minor}`);

    if (!shouldPushTag) {
      versionTag = computeVersionTag(major, minor, listAllTags(cwd), prefix);
      console.log(`Computed version tag: ${versionTag}`);
      console.log("Tag creation and push are disabled (push-tag is false)");
    } else {
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        ensureTagsFetched(cwd, authEnvironment);

        const existingTag = findExistingVersionTag(gitLines(cwd, "tag", "--points-at", sha), prefix);
        if (existingTag) {
          console.log(`HEAD already has version tag: ${existingTag}`);
          versionTag = existingTag;
          break;
        }

        const candidate = computeVersionTag(major, minor, listAllTags(cwd), prefix);
        console.log(`Computed version tag: ${candidate}`);
        createLightweightTag(cwd, candidate, sha);

        const { status, output } = pushVersionTag(cwd, candidate, authEnvironment);
        if (status === 0) {
          console.log(`Pushed version tag: ${candidate}`);
          versionTag = candidate;
          break;
        }

        console.log(`Push failed (attempt ${attempt}/${retries}) for version tag '${candidate}':\n${output}`);
        deleteLocalTag(cwd, candidate);

        if (attempt === retries || !shouldRetryPush(output)) {
          fail(`Failed to push version tag after ${attempt} attempt(s).`);
        }

        await sleep(retrySleep);
      }
    }
  }

  if (!versionTag) {
    fail("Version tag was not created");
  }

  const {
    version,
    versionMajor,
    versionMinor,
    versionPatch,
    versionCode,
  } = versionDetailsFromTag(versionTag, prefix);
  console.log("\nRESULT");
  console.log(`Version:     ${version}`);
  console.log(`Version tag: ${versionTag}`);
  console.log(`Version code: ${versionCode}`);

  await writeGithubOutput("commit", sha);
  await writeGithubOutput("version", version);
  await writeGithubOutput("version_tag", versionTag);
  await writeGithubOutput("version_major", versionMajor);
  await writeGithubOutput("version_minor", versionMinor);
  await writeGithubOutput("version_patch", versionPatch);
  await writeGithubOutput("version_code", versionCode);

  return {
    version,
    versionTag,
    versionMajor,
    versionMinor,
    versionPatch,
    versionCode,
  };
}

async function main() {
  await tagVersion();
}

const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
