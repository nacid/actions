import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_QEMU_IMAGE,
  PLATFORMS,
  assertSupportedPlatforms,
  buildArguments,
  createBuilderName,
  imageMetadata,
  normalizeAdditionalTags,
  normalizeBooleanInput,
  normalizeBranchTag,
  normalizeImageRepository,
  normalizeQemuSetup,
  publishDockerImage,
  qemuArchitectures,
  readActionInput,
  resolveWorkingDirectory,
  validateVersionTag,
} from "./docker.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;

function successfulCommand(calls) {
  return async (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });

    if (command === "docker" && args[0] === "buildx" && args[1] === "inspect") {
      return {
        status: 0,
        output: "Platforms: linux/amd64, linux/amd64/v2, linux/arm64, linux/arm64/v8",
      };
    }

    if (command === "docker" && args[0] === "buildx" && args[1] === "build") {
      const metadataFile = args[args.indexOf("--metadata-file") + 1];
      await writeFile(metadataFile, JSON.stringify({ "containerimage.digest": DIGEST }), "utf8");
    }

    return { status: 0, output: "" };
  };
}

function runNode(args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];

    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({
        status: status ?? 1,
        output: Buffer.concat(output).toString("utf8"),
      });
    });
  });
}

function parseWorkflowOutputs(source) {
  const outputs = new Map();
  const lines = source.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const multiline = /^([^<]+)<<(.+)$/u.exec(line);
    if (multiline) {
      const [, name, delimiter] = multiline;
      const values = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        values.push(lines[index]);
        index += 1;
      }
      outputs.set(name, values.join("\n"));
      continue;
    }

    const separator = line.indexOf("=");
    if (separator > 0) {
      outputs.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  return outputs;
}

test("entrypoint runs when the action directory is reached through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-entrypoint-"));
  const actionDirectory = fileURLToPath(new URL(".", import.meta.url));
  const linkedDirectory = join(root, "action");

  try {
    await symlink(
      actionDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const environment = {
      ...process.env,
      "INPUT_REGISTRY-USER": "",
      INPUT_REGISTRY_USER: "",
    };
    const result = await runNode([join(linkedDirectory, "index.mjs")], {
      cwd: root,
      env: environment,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.output, /Expected a non-empty 'registry-user' input/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizeBranchTag follows Docker tag rules and limits the result to 128 characters", () => {
  assert.equal(normalizeBranchTag("Feature/Voice API"), "feature-voice-api");
  assert.equal(normalizeBranchTag("---Release_1.2---"), "release_1.2");
  assert.equal(normalizeBranchTag(`Feature/${"A".repeat(200)}`).length, 128);
  assert.throws(() => normalizeBranchTag("...---"), /Unable to derive a Docker tag/u);
});

test("image repository normalization accepts registry ports and rejects tags in the image input", () => {
  assert.equal(
    normalizeImageRepository("registry.example.test:5443/", "/team/token-service/"),
    "registry.example.test:5443/team/token-service",
  );
  assert.throws(
    () => normalizeImageRepository("https://registry.example.test", "team/service"),
    /without a URL scheme, path, or whitespace/u,
  );
  assert.throws(
    () => normalizeImageRepository("registry.example.test/team", "service"),
    /without a URL scheme, path, or whitespace/u,
  );
  assert.throws(
    () => normalizeImageRepository("registry.example.test", "team/service:latest"),
    /without a tag or digest/u,
  );
  assert.throws(
    () => normalizeImageRepository("registry.example.test", "team//service"),
    /lowercase repository path/u,
  );
});

test("action inputs support hyphenated and underscore environment names", () => {
  assert.equal(readActionInput("registry-image", { "INPUT_REGISTRY-IMAGE": " team/service " }), "team/service");
  assert.equal(readActionInput("registry-password", { INPUT_REGISTRY_PASSWORD: " token " }), "token");
});

test("working directory resolves relative to GITHUB_WORKSPACE", () => {
  assert.equal(
    resolveWorkingDirectory("Project", { GITHUB_WORKSPACE: "/work/checkout" }),
    resolve("/work/checkout", "Project"),
  );
});

test("version must be usable as a Docker tag", () => {
  assert.equal(validateVersionTag("1.12.3-rc.1"), "1.12.3-rc.1");
  assert.throws(() => validateVersionTag("version/1.2.3"), /not a valid Docker tag/u);
});

test("additional tags and boolean inputs are normalized and validated", () => {
  assert.deepEqual(
    normalizeAdditionalTags(" latest \r\nsha-1234567\n\n"),
    ["latest", "sha-1234567"],
  );
  assert.throws(
    () => normalizeAdditionalTags("registry.example.test/team/service:latest"),
    /not a valid Docker tag name/u,
  );
  assert.equal(normalizeBooleanInput("pull", " TRUE "), true);
  assert.equal(normalizeBooleanInput("pull", "", false), false);
  assert.throws(() => normalizeBooleanInput("pull", "yes"), /must be 'true' or 'false'/u);
});

test("imageMetadata combines branch, version, and additional tags without duplicates", () => {
  assert.deepEqual(
    imageMetadata({
      registry: "registry.example.test",
      registryImage: "team/token-service",
      version: "2.4.9",
      branch: "Feature/Voice API",
      commit: COMMIT,
      tags: ["latest", "2.4.9"],
    }),
    {
      image: "registry.example.test/team/token-service",
      branch: "Feature/Voice API",
      branchTag: "feature-voice-api",
      version: "2.4.9",
      commit: "0123456789ab",
      tagNames: ["feature-voice-api", "2.4.9", "latest"],
      references: [
        "registry.example.test/team/token-service:feature-voice-api",
        "registry.example.test/team/token-service:2.4.9",
        "registry.example.test/team/token-service:latest",
      ],
      branchReference: "registry.example.test/team/token-service:feature-voice-api",
      versionReference: "registry.example.test/team/token-service:2.4.9",
    },
  );
});

test("imageMetadata allows version to be omitted", () => {
  const metadata = imageMetadata({
    registry: "registry.example.test",
    registryImage: "team/service",
    branch: "main",
    commit: COMMIT,
    tags: "latest\nsha-0123456",
  });

  assert.equal(metadata.version, "");
  assert.equal(metadata.versionReference, "");
  assert.deepEqual(metadata.tagNames, ["main", "latest", "sha-0123456"]);
  assert.ok(
    !buildArguments({
      builder: "test-builder",
      context: ".",
      dockerfile: "Dockerfile",
      metadataFile: "metadata.json",
      metadata,
    }).some((argument) => argument.startsWith("APP_VERSION=")),
  );
});

test("buildArguments includes all tags, labels, pulling, and external caches", () => {
  const metadata = imageMetadata({
    registry: "registry.example.test",
    registryImage: "team/service",
    version: "3.1.4",
    branch: "main",
    commit: COMMIT,
    tags: ["latest", "sha-0123456"],
  });

  assert.deepEqual(
    buildArguments({
      builder: "test-builder",
      context: "services/api",
      dockerfile: "services/api/Dockerfile",
      metadataFile: "metadata.json",
      metadata,
      labels: [
        "org.opencontainers.image.revision=0123456789ab",
        "org.opencontainers.image.version=latest",
      ],
      pull: true,
      cacheFrom: ["type=gha"],
      cacheTo: ["type=gha,mode=max"],
    }),
    [
      "buildx",
      "build",
      "--builder",
      "test-builder",
      "--platform",
      "linux/amd64,linux/arm64",
      "--file",
      "services/api/Dockerfile",
      "--build-arg",
      "APP_BRANCH=main",
      "--build-arg",
      "APP_COMMIT=0123456789ab",
      "--build-arg",
      "APP_VERSION=3.1.4",
      "--label",
      "org.opencontainers.image.revision=0123456789ab",
      "--label",
      "org.opencontainers.image.version=latest",
      "--tag",
      "registry.example.test/team/service:main",
      "--tag",
      "registry.example.test/team/service:3.1.4",
      "--tag",
      "registry.example.test/team/service:latest",
      "--tag",
      "registry.example.test/team/service:sha-0123456",
      "--cache-from",
      "type=gha",
      "--cache-to",
      "type=gha,mode=max",
      "--metadata-file",
      "metadata.json",
      "--pull",
      "--push",
      "services/api",
    ],
  );
  assert.deepEqual(PLATFORMS, ["linux/amd64", "linux/arm64"]);
});

test("platform inspection reports missing binfmt support", () => {
  assert.doesNotThrow(() => assertSupportedPlatforms("Platforms: linux/amd64, linux/arm64/v8"));
  assert.throws(
    () => assertSupportedPlatforms("Platforms: linux/amd64"),
    /linux\/arm64.*binfmt\/QEMU/u,
  );
});

test("QEMU configuration accepts auto or never and converts platforms to architectures", () => {
  assert.equal(normalizeQemuSetup(" AUTO "), "auto");
  assert.equal(normalizeQemuSetup("never"), "never");
  assert.throws(() => normalizeQemuSetup("always"), /must be 'auto' or 'never'/u);
  assert.deepEqual(qemuArchitectures(["linux/arm64", "linux/amd64/v3"]), ["arm64", "amd64"]);
});

test("builder names are scoped to the CI run and action process", () => {
  assert.equal(
    createBuilderName({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }, 456, 0),
    "docker-123-2-456",
  );
});

test("publishDockerImage publishes every tag with labels and cache settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-test-"));
  const outputPath = join(root, "github-output.txt");
  const calls = [];
  const command = successfulCommand(calls);
  const project = join(root, "Project");

  try {
    await mkdir(project);
    const result = await publishDockerImage({
      registry: "registry.example.test",
      registryImage: "team/service",
      registryUser: "ci-user",
      registryPassword: "top-secret",
      version: "1.8.3",
      tags: "latest\nsha-0123456\n1.8.3",
      labels: [
        "org.opencontainers.image.revision=0123456789ab",
        "org.opencontainers.image.version=latest",
      ],
      pull: true,
      cacheFrom: ["type=gha"],
      cacheTo: ["type=gha,mode=max"],
      branch: "Feature/New API",
      commit: COMMIT,
      context: ".",
      dockerfile: "Dockerfile",
      workingDirectory: "Project",
      environment: {
        GITHUB_RUN_ID: "10",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKSPACE: root,
      },
      builder: "test-builder",
      tempDirectory: root,
      outputPath,
      command,
    });

    assert.equal(result.branchReference, "registry.example.test/team/service:feature-new-api");
    assert.equal(result.versionReference, "registry.example.test/team/service:1.8.3");
    assert.deepEqual(result.references, [
      "registry.example.test/team/service:feature-new-api",
      "registry.example.test/team/service:1.8.3",
      "registry.example.test/team/service:latest",
      "registry.example.test/team/service:sha-0123456",
    ]);
    assert.equal(result.digest, DIGEST);
    assert.ok(calls.every(({ options }) => options.cwd === project));

    const login = calls.find(({ args }) => args[0] === "login");
    assert.deepEqual(login.args, [
      "login",
      "registry.example.test",
      "--username",
      "ci-user",
      "--password-stdin",
    ]);
    assert.equal(login.options.input, "top-secret\n");
    assert.ok(!JSON.stringify(calls.map(({ args }) => args)).includes("top-secret"));

    const build = calls.find(({ args }) => args[0] === "buildx" && args[1] === "build");
    assert.ok(build.args.includes("linux/amd64,linux/arm64"));
    assert.ok(build.args.includes("APP_BRANCH=Feature/New API"));
    assert.ok(build.args.includes("org.opencontainers.image.version=latest"));
    assert.ok(build.args.includes("type=gha,mode=max"));
    assert.ok(build.args.includes("--pull"));

    assert.deepEqual(calls.slice(-2).map(({ args }) => args), [
      ["buildx", "rm", "test-builder"],
      ["logout", "registry.example.test"],
    ]);

    const outputs = parseWorkflowOutputs(await readFile(outputPath, "utf8"));
    assert.equal(outputs.get("image"), "registry.example.test/team/service");
    assert.equal(
      outputs.get("tags"),
      [
        "registry.example.test/team/service:feature-new-api",
        "registry.example.test/team/service:1.8.3",
        "registry.example.test/team/service:latest",
        "registry.example.test/team/service:sha-0123456",
      ].join("\n"),
    );
    assert.equal(
      outputs.get("branch-tag"),
      "registry.example.test/team/service:feature-new-api",
    );
    assert.equal(
      outputs.get("version-tag"),
      "registry.example.test/team/service:1.8.3",
    );
    assert.equal(outputs.get("commit"), "0123456789ab");
    assert.equal(outputs.get("digest"), DIGEST);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishDockerImage cleans up the builder and login after a build failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-failure-"));
  const calls = [];
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "buildx" && args[1] === "inspect") {
      return { status: 0, output: "Platforms: linux/amd64, linux/arm64" };
    }
    if (args[0] === "buildx" && args[1] === "build") {
      throw new Error("simulated build failure");
    }
    return { status: 0, output: "" };
  };

  try {
    await assert.rejects(
      publishDockerImage({
        registry: "registry.example.test",
        registryImage: "team/service",
        registryUser: "ci-user",
        registryPassword: "top-secret",
        version: "1.0.0",
        branch: "main",
        commit: COMMIT,
        environment: {},
        builder: "failure-builder",
        tempDirectory: root,
        command,
      }),
      /simulated build failure/u,
    );

    assert.deepEqual(calls.slice(-2).map(({ args }) => args), [
      ["buildx", "rm", "failure-builder"],
      ["logout", "registry.example.test"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishDockerImage configures missing QEMU emulation and recreates the builder", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-qemu-"));
  const calls = [];
  let inspections = 0;
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "buildx" && args[1] === "inspect") {
      inspections += 1;
      return {
        status: 0,
        output: inspections === 1
          ? "Platforms: linux/amd64"
          : "Platforms: linux/amd64, linux/arm64",
      };
    }
    if (args[0] === "buildx" && args[1] === "build") {
      const metadataFile = args[args.indexOf("--metadata-file") + 1];
      await writeFile(metadataFile, JSON.stringify({ "containerimage.digest": DIGEST }), "utf8");
    }
    return { status: 0, output: "" };
  };

  try {
    await publishDockerImage({
      registry: "registry.example.test",
      registryImage: "team/service",
      registryUser: "ci-user",
      registryPassword: "top-secret",
      version: "1.0.0",
      branch: "main",
      commit: COMMIT,
      environment: {},
      builder: "qemu-builder",
      tempDirectory: root,
      command,
    });

    const qemu = calls.find(({ args }) => args[0] === "run");
    assert.deepEqual(qemu.args, [
      "run",
      "--privileged",
      "--rm",
      DEFAULT_QEMU_IMAGE,
      "--install",
      "arm64",
    ]);
    assert.equal(calls.filter(({ args }) => args[0] === "buildx" && args[1] === "create").length, 2);
    assert.equal(inspections, 2);

    const qemuIndex = calls.indexOf(qemu);
    const loginIndex = calls.findIndex(({ args }) => args[0] === "login");
    assert.ok(qemuIndex < loginIndex, "registry login must happen after QEMU setup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qemu-setup never reports missing platforms without changing daemon configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-qemu-never-"));
  const calls = [];
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "buildx" && args[1] === "inspect") {
      return { status: 0, output: "Platforms: linux/amd64" };
    }
    return { status: 0, output: "" };
  };

  try {
    await assert.rejects(
      publishDockerImage({
        registry: "registry.example.test",
        registryImage: "team/service",
        registryUser: "ci-user",
        registryPassword: "top-secret",
        version: "1.0.0",
        branch: "main",
        commit: COMMIT,
        qemuSetup: "never",
        environment: {},
        builder: "qemu-never-builder",
        tempDirectory: root,
        command,
      }),
      /qemu-setup is 'never'/u,
    );

    assert.ok(!calls.some(({ args }) => args[0] === "run"));
    assert.ok(!calls.some(({ args }) => args[0] === "login"));
    assert.deepEqual(calls.at(-1).args, ["buildx", "rm", "qemu-never-builder"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic QEMU setup explains the privileged daemon requirement on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-qemu-failure-"));
  const calls = [];
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "buildx" && args[1] === "inspect") {
      return { status: 0, output: "Platforms: linux/amd64" };
    }
    if (args[0] === "run") {
      throw new Error("privileged mode denied");
    }
    return { status: 0, output: "" };
  };

  try {
    await assert.rejects(
      publishDockerImage({
        registry: "registry.example.test",
        registryImage: "team/service",
        registryUser: "ci-user",
        registryPassword: "top-secret",
        version: "1.0.0",
        branch: "main",
        commit: COMMIT,
        environment: {},
        builder: "qemu-failure-builder",
        tempDirectory: root,
        command,
      }),
      /Docker daemon must allow privileged containers.*privileged mode denied/u,
    );

    assert.ok(!calls.some(({ args }) => args[0] === "login"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishDockerImage attempts cleanup when builder creation partially fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-create-failure-"));
  const calls = [];
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], options });
    if (args[0] === "buildx" && args[1] === "create") {
      throw new Error("simulated builder creation failure");
    }
    return { status: 0, output: "" };
  };

  try {
    await assert.rejects(
      publishDockerImage({
        registry: "registry.example.test",
        registryImage: "team/service",
        registryUser: "ci-user",
        registryPassword: "top-secret",
        version: "1.0.0",
        branch: "main",
        commit: COMMIT,
        environment: {},
        builder: "partial-builder",
        tempDirectory: root,
        command,
      }),
      /simulated builder creation failure/u,
    );

    assert.deepEqual(calls.at(-1).args, ["buildx", "rm", "partial-builder"]);
    assert.ok(!calls.some(({ args }) => args[0] === "login"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid configuration fails before any Docker command", async () => {
  let commandCalls = 0;
  const command = async () => {
    commandCalls += 1;
    return { status: 0, output: "" };
  };

  await assert.rejects(
    publishDockerImage({
      registry: "registry.example.test",
      registryImage: "team/service",
      registryUser: "ci-user",
      registryPassword: "top-secret",
      version: "version/1.0.0",
      branch: "main",
      commit: COMMIT,
      environment: {},
      command,
    }),
    /not a valid Docker tag/u,
  );

  await assert.rejects(
    publishDockerImage({
      registry: "registry.example.test",
      registryImage: "team/service",
      registryUser: "ci-user",
      registryPassword: "top-secret",
      tags: "registry.example.test/team/service:latest",
      branch: "main",
      commit: COMMIT,
      environment: {},
      command,
    }),
    /not a valid Docker tag name/u,
  );

  await assert.rejects(
    publishDockerImage({
      registry: "registry.example.test",
      registryImage: "team/service",
      registryUser: "ci-user",
      registryPassword: "top-secret",
      pull: "yes",
      branch: "main",
      commit: COMMIT,
      environment: {},
      command,
    }),
    /must be 'true' or 'false'/u,
  );

  assert.equal(commandCalls, 0);
});
