import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const PLATFORMS = ["linux/amd64", "linux/arm64"];
export const DEFAULT_QEMU_IMAGE = "docker.io/tonistiigi/binfmt:qemu-v10.2.3-68";

const DOCKER_TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u;
const COMMIT_RE = /^[0-9a-f]{7,64}$/iu;
const REPOSITORY_PATH_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u;

function fail(message) {
  throw new Error(message);
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

export function readActionInput(name, environment = process.env) {
  const normalized = name.trim().replaceAll(" ", "_").toUpperCase();
  const canonical = environment[`INPUT_${normalized}`];
  const underscoreAlias = environment[`INPUT_${normalized.replaceAll("-", "_")}`];
  return (canonical ?? underscoreAlias ?? "").trim();
}

export function resolveWorkingDirectory(
  directory,
  environment = process.env,
  fallback = process.cwd(),
) {
  const workspace = (environment.GITHUB_WORKSPACE ?? "").trim() || fallback;
  const normalized = (directory ?? "").trim() || ".";
  return isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
}

function required(value, name) {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    fail(`Expected a non-empty '${name}' input`);
  }
  return normalized;
}

function formatArgument(argument) {
  return /^[a-zA-Z0-9_./:=,@+-]+$/u.test(argument) ? argument : JSON.stringify(argument);
}

export async function runCommand(command, args, {
  capture = true,
  check = true,
  cwd = process.cwd(),
  environment = process.env,
  input,
} = {}) {
  console.log(`+ ${command} ${args.map(formatArgument).join(" ")}`);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];

    child.stdout.on("data", (chunk) => {
      if (capture) {
        output.push(chunk);
      }
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (capture) {
        output.push(chunk);
      }
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      rejectPromise(new Error(`Failed to run ${command}: ${error.message}`));
    });
    child.on("close", (status) => {
      const combinedOutput = Buffer.concat(output).toString("utf8").trim();
      if (check && status !== 0) {
        rejectPromise(new Error(`Command failed with exit code ${status}: ${command} ${args.map(formatArgument).join(" ")}`));
        return;
      }
      resolvePromise({ status: status ?? 1, output: combinedOutput });
    });

    child.stdin.end(input);
  });
}

export function normalizeBranchTag(branch) {
  const normalized = required(branch, "branch")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^[^a-z0-9_]+/u, "")
    .replace(/[^a-z0-9_]+$/u, "")
    .slice(0, 128);

  if (!normalized) {
    fail(`Unable to derive a Docker tag from branch '${branch}'`);
  }
  return normalized;
}

export function normalizeImageRepository(registry, registryImage) {
  const normalizedRegistry = required(registry, "registry").replace(/\/+$/u, "");
  const normalizedImage = required(registryImage, "registry-image").replace(/^\/+|\/+$/gu, "");

  if (!normalizedRegistry || normalizedRegistry.includes("://") || normalizedRegistry.includes("/") || /\s/u.test(normalizedRegistry)) {
    fail(`Registry '${registry}' must be a host name without a URL scheme, path, or whitespace`);
  }
  if (!REPOSITORY_PATH_RE.test(normalizedImage)) {
    fail(`Registry image '${registryImage}' must be a lowercase repository path without a tag or digest`);
  }

  return `${normalizedRegistry}/${normalizedImage}`;
}

export function validateVersionTag(version) {
  const normalized = required(version, "version");
  if (!DOCKER_TAG_RE.test(normalized)) {
    fail(`Version '${version}' is not a valid Docker tag`);
  }
  return normalized;
}

export function parseMultilineInput(value) {
  return (value ?? "")
    .split(/\r?\n/gu)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeAdditionalTags(value) {
  const tags = Array.isArray(value) ? value : parseMultilineInput(value);
  return tags.map((tag) => {
    const normalized = required(tag, "tags");
    if (!DOCKER_TAG_RE.test(normalized)) {
      fail(`Additional tag '${tag}' is not a valid Docker tag name`);
    }
    return normalized;
  });
}

export function normalizeBooleanInput(name, value, fallback = false) {
  const normalized = (value ?? "").toString().trim().toLowerCase();
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

export function normalizeQemuSetup(value) {
  const normalized = (value ?? "auto").trim().toLowerCase();
  if (!new Set(["auto", "never"]).has(normalized)) {
    fail(`Input 'qemu-setup' must be 'auto' or 'never', got: ${value}`);
  }
  return normalized;
}

export function normalizeCommit(commit) {
  const normalized = required(commit, "commit");
  if (!COMMIT_RE.test(normalized)) {
    fail(`Commit '${commit}' must be a hexadecimal Git object ID`);
  }
  return normalized.slice(0, 12).toLowerCase();
}

export function imageMetadata({
  registry,
  registryImage,
  version,
  branch,
  commit,
  tags = [],
}) {
  const image = normalizeImageRepository(registry, registryImage);
  const branchTag = normalizeBranchTag(branch);
  const normalizedVersion = (version ?? "").trim() ? validateVersionTag(version) : "";
  const normalizedCommit = normalizeCommit(commit);
  const tagNames = [
    ...new Set([
      branchTag,
      ...(normalizedVersion ? [normalizedVersion] : []),
      ...normalizeAdditionalTags(tags),
    ]),
  ];
  const references = tagNames.map((tag) => `${image}:${tag}`);

  return {
    image,
    branch,
    branchTag,
    version: normalizedVersion,
    commit: normalizedCommit,
    tagNames,
    references,
    branchReference: `${image}:${branchTag}`,
    versionReference: normalizedVersion ? `${image}:${normalizedVersion}` : "",
  };
}

export function buildArguments({
  builder,
  context,
  dockerfile,
  metadataFile,
  metadata,
  labels = [],
  pull = false,
  cacheFrom = [],
  cacheTo = [],
}) {
  const args = [
    "buildx",
    "build",
    "--builder",
    builder,
    "--platform",
    PLATFORMS.join(","),
    "--file",
    dockerfile,
    "--build-arg",
    `APP_BRANCH=${metadata.branch}`,
    "--build-arg",
    `APP_COMMIT=${metadata.commit}`,
  ];

  if (metadata.version) {
    args.push("--build-arg", `APP_VERSION=${metadata.version}`);
  }
  for (const label of labels) {
    args.push("--label", label);
  }
  for (const reference of metadata.references) {
    args.push("--tag", reference);
  }
  for (const cache of cacheFrom) {
    args.push("--cache-from", cache);
  }
  for (const cache of cacheTo) {
    args.push("--cache-to", cache);
  }
  args.push(
    "--metadata-file",
    metadataFile,
  );
  if (pull) {
    args.push("--pull");
  }
  args.push(
    "--push",
    context,
  );
  return args;
}

export function missingPlatforms(inspectOutput) {
  return PLATFORMS.filter((platform) => !new RegExp(`\\b${platform.replace("/", "\\/")}\\b`, "u").test(inspectOutput));
}

export function assertSupportedPlatforms(inspectOutput) {
  const missing = missingPlatforms(inspectOutput);
  if (missing.length > 0) {
    fail(`Buildx builder does not support required platform(s): ${missing.join(", ")}. Configure binfmt/QEMU on the runner.`);
  }
}

export function qemuArchitectures(platforms) {
  return platforms.map((platform) => platform.replace(/^linux\//u, "").replace(/\/.*$/u, ""));
}

export function createBuilderName(environment = process.env, pid = process.pid, now = Date.now()) {
  const runId = (environment.GITHUB_RUN_ID ?? environment.FORGEJO_RUN_NUMBER ?? String(now)).trim();
  const attempt = (environment.GITHUB_RUN_ATTEMPT ?? "1").trim();
  const suffix = `${runId}-${attempt}-${pid}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `docker-${suffix}`.slice(0, 63).replace(/[^a-z0-9]+$/u, "");
}

function branchFromEnvironment(environment) {
  const refName = (environment.GITHUB_REF_NAME ?? "").trim();
  if (refName) {
    return refName;
  }

  const ref = (environment.GITHUB_REF ?? "").trim();
  return ref.replace(/^refs\/heads\//u, "");
}

function workflowCommandValue(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function maskSecret(secret) {
  console.log(`::add-mask::${workflowCommandValue(secret)}`);
}

async function writeOutput(outputPath, name, value) {
  if (!outputPath) {
    return;
  }
  if (!value.includes("\n")) {
    await appendFile(outputPath, `${name}=${value}\n`, "utf8");
    return;
  }

  const delimiter = `docker-${randomUUID()}`;
  await appendFile(
    outputPath,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    "utf8",
  );
}

async function cleanupCommand(command, args, options, label) {
  try {
    const result = await command("docker", args, { ...options, check: false });
    if (result.status !== 0) {
      console.warn(`Cleanup warning: ${label} exited with code ${result.status}`);
    }
  } catch (error) {
    console.warn(`Cleanup warning: ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function publishedDigest(metadata) {
  const digest = metadata?.["containerimage.digest"];
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    fail("Buildx metadata did not contain a valid multi-platform image digest");
  }
  return digest;
}

export async function publishDockerImage(options = {}) {
  const environment = options.environment ?? process.env;
  const command = options.command ?? runCommand;
  const cwd = options.cwd ?? resolveWorkingDirectory(
    options.workingDirectory ?? readActionInput("working-directory", environment),
    environment,
  );
  const registry = options.registry ?? readActionInput("registry", environment);
  const registryImage = options.registryImage ?? readActionInput("registry-image", environment);
  const registryUser = required(options.registryUser ?? readActionInput("registry-user", environment), "registry-user");
  const registryPassword = required(options.registryPassword ?? readActionInput("registry-password", environment), "registry-password");
  const version = options.version ?? readActionInput("version", environment);
  const tags = options.tags ?? readActionInput("tags", environment);
  const labels = Array.isArray(options.labels)
    ? options.labels
    : parseMultilineInput(options.labels ?? readActionInput("labels", environment));
  const cacheFrom = Array.isArray(options.cacheFrom)
    ? options.cacheFrom
    : parseMultilineInput(options.cacheFrom ?? readActionInput("cache-from", environment));
  const cacheTo = Array.isArray(options.cacheTo)
    ? options.cacheTo
    : parseMultilineInput(options.cacheTo ?? readActionInput("cache-to", environment));
  const pull = normalizeBooleanInput(
    "pull",
    options.pull ?? readActionInput("pull", environment),
  );
  const context = required(options.context ?? (readActionInput("context", environment) || "."), "context");
  const dockerfile = required(
    options.dockerfile ?? (readActionInput("dockerfile", environment) || "Dockerfile"),
    "dockerfile",
  );
  const qemuSetup = normalizeQemuSetup(
    options.qemuSetup ?? (readActionInput("qemu-setup", environment) || "auto"),
  );
  const qemuImage = required(
    options.qemuImage ?? (readActionInput("qemu-image", environment) || DEFAULT_QEMU_IMAGE),
    "qemu-image",
  );
  const outputPath = options.outputPath ?? (environment.GITHUB_OUTPUT ?? "").trim();
  const tempRoot = options.tempDirectory ?? ((environment.RUNNER_TEMP ?? "").trim() || tmpdir());
  const builder = options.builder ?? createBuilderName(environment);

  await requireDirectory(cwd);
  let branch = options.branch ?? branchFromEnvironment(environment);
  if (!branch) {
    branch = (await command("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, environment })).output.trim();
  }

  let commit = options.commit ?? (environment.GITHUB_SHA ?? "").trim();
  if (!commit) {
    commit = (await command("git", ["rev-parse", "HEAD"], { cwd, environment })).output.trim();
  }

  const metadata = imageMetadata({
    registry,
    registryImage,
    version,
    branch,
    commit,
    tags,
  });
  await mkdir(tempRoot, { recursive: true });
  const workDirectory = await mkdtemp(join(tempRoot, "docker-"));
  const dockerConfig = join(workDirectory, "docker-config");
  const metadataFile = join(workDirectory, "build-metadata.json");
  await mkdir(dockerConfig, { recursive: true });
  const dockerEnvironment = { ...environment, DOCKER_CONFIG: dockerConfig };
  const commandOptions = { cwd, environment: dockerEnvironment };
  let loggedIn = false;
  let builderCreationAttempted = false;

  maskSecret(registryPassword);

  try {
    await command("docker", ["--version"], commandOptions);
    await command("docker", ["buildx", "version"], commandOptions);
    await command("docker", ["info"], commandOptions);

    builderCreationAttempted = true;
    await command(
      "docker",
      [
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--driver-opt",
        "network=host",
      ],
      commandOptions,
    );
    let inspect = await command("docker", ["buildx", "inspect", builder, "--bootstrap"], commandOptions);
    let missing = missingPlatforms(inspect.output);

    if (missing.length > 0 && qemuSetup === "auto") {
      console.log(`Buildx is missing ${missing.join(", ")}; configuring QEMU with ${qemuImage}`);
      await command("docker", ["buildx", "rm", builder], commandOptions);
      builderCreationAttempted = false;

      try {
        await command(
          "docker",
          ["run", "--privileged", "--rm", qemuImage, "--install", qemuArchitectures(missing).join(",")],
          commandOptions,
        );
      } catch (error) {
        fail(`Unable to configure QEMU. The Docker daemon must allow privileged containers: ${error instanceof Error ? error.message : String(error)}`);
      }

      builderCreationAttempted = true;
      await command(
        "docker",
        [
          "buildx",
          "create",
          "--name",
          builder,
          "--driver",
          "docker-container",
          "--driver-opt",
          "network=host",
        ],
        commandOptions,
      );
      inspect = await command("docker", ["buildx", "inspect", builder, "--bootstrap"], commandOptions);
      missing = missingPlatforms(inspect.output);
    }

    if (missing.length > 0 && qemuSetup === "never") {
      fail(`Buildx builder does not support required platform(s): ${missing.join(", ")} and qemu-setup is 'never'`);
    }
    assertSupportedPlatforms(inspect.output);

    await command(
      "docker",
      ["login", registry.replace(/\/+$/u, ""), "--username", registryUser, "--password-stdin"],
      { ...commandOptions, input: `${registryPassword}\n` },
    );
    loggedIn = true;

    await command(
      "docker",
      buildArguments({
        builder,
        context,
        dockerfile,
        metadataFile,
        metadata,
        labels,
        pull,
        cacheFrom,
        cacheTo,
      }),
      { ...commandOptions, capture: false },
    );
    const digest = publishedDigest(JSON.parse(await readFile(metadataFile, "utf8")));

    await writeOutput(outputPath, "image", metadata.image);
    await writeOutput(outputPath, "tags", metadata.references.join("\n"));
    await writeOutput(outputPath, "branch-tag", metadata.branchReference);
    if (metadata.versionReference) {
      await writeOutput(outputPath, "version-tag", metadata.versionReference);
    }
    await writeOutput(outputPath, "commit", metadata.commit);
    await writeOutput(outputPath, "digest", digest);

    for (const reference of metadata.references) {
      console.log(`Published ${reference}`);
    }
    console.log(`Digest: ${digest}`);

    return { ...metadata, digest };
  } finally {
    if (builderCreationAttempted) {
      await cleanupCommand(command, ["buildx", "rm", builder], commandOptions, "remove Buildx builder");
    }
    if (loggedIn) {
      await cleanupCommand(
        command,
        ["logout", registry.replace(/\/+$/u, "")],
        commandOptions,
        "registry logout",
      );
    }
    try {
      await rm(workDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Cleanup warning: failed to remove temporary directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
