import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildGitAuthEnvironment,
  computeVersionTag,
  findExistingVersionTag,
  getVersionMajorMinor,
  parseBooleanInput,
  readActionInput,
  resolveWorkingDirectory,
  tagVersion,
  versionDetailsFromTag,
} from "./index.mjs";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return (result.stdout ?? "").trim();
}

test("entrypoint reached through a symlink reports errors instead of silently succeeding", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-linked-entrypoint-"));
  const linkedDirectory = join(root, "action");
  const missingWorkspace = join(root, "missing");
  try {
    await symlink(
      fileURLToPath(new URL(".", import.meta.url)),
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = spawnSync(process.execPath, [join(linkedDirectory, "index.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: missingWorkspace,
        INPUT_WORKING_DIRECTORY: missingWorkspace,
        "INPUT_WORKING-DIRECTORY": missingWorkspace,
      },
    });
    assert.equal(result.status, 1, `Expected the action to run and fail, got: ${result.stdout ?? ""}${result.stderr ?? ""}`);
    assert.match(result.stderr, /Working directory '.+' is not accessible/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computeVersionTag increments only the selected major.minor series", () => {
  assert.equal(
    computeVersionTag(1, 4, ["version/1.4.0", "version/1.3.20", "version/1.4.7", "other/1.4.99"]),
    "version/1.4.8",
  );
  assert.equal(computeVersionTag(2, 0, []), "version/2.0.0");
});

test("findExistingVersionTag selects the highest version on the commit", () => {
  assert.equal(
    findExistingVersionTag(["version/1.4.20", "version/2.0.9", "version/2.1.0", "other/9.0.0"]),
    "version/2.1.0",
  );
  assert.equal(findExistingVersionTag(["release/2.0.9"]), undefined);
});

test("versionDetailsFromTag computes individual outputs and version code", () => {
  assert.deepEqual(versionDetailsFromTag("version/0.3.10"), {
    version: "0.3.10",
    versionMajor: 0,
    versionMinor: 3,
    versionPatch: 10,
    versionCode: 3010,
  });
});

test("custom prefixes select only matching full versions and are treated literally", () => {
  for (const prefix of ["v", "release+."]) {
    const tags = [
      `${prefix}3.0.4`, `${prefix}3.0.1`, `${prefix}3.1.20`,
      "version/3.0.99", "releaseXX3.0.88", "v3", "v3.0", `${prefix}3.0.5-rc.1`,
    ];
    assert.equal(computeVersionTag(3, 0, tags, prefix), `${prefix}3.0.5`);
    assert.equal(findExistingVersionTag(tags, prefix), `${prefix}3.1.20`);
    assert.deepEqual(versionDetailsFromTag(`${prefix}3.0.4`, prefix), {
      version: "3.0.4", versionMajor: 3, versionMinor: 0, versionPatch: 4, versionCode: 3000004,
    });
    assert.throws(() => versionDetailsFromTag("version/3.0.99", prefix), /Invalid version tag/u);
  }
});

test("push-tag accepts only booleans and defaults to true", () => {
  assert.equal(parseBooleanInput("push-tag", "", true), true);
  assert.equal(parseBooleanInput("push-tag", " false ", true), false);
  assert.equal(parseBooleanInput("push-tag", true, false), true);
  assert.throws(() => parseBooleanInput("push-tag", "yes", true), /must be 'true' or 'false'/u);
});

test("PY_TOML resolves its adjacent handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-handler-"));
  try {
    const source = join(root, "pyproject.toml");
    await writeFile(source, "[project]\nname = 'example'\nversion = '3.12.9-rc.1'\n", "utf8");

    assert.deepEqual(await getVersionMajorMinor("PY_TOML", source), { major: 3, minor: 12 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UNITY resolves its adjacent handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-unity-handler-"));
  try {
    const source = join(root, "ProjectSettings.asset");
    await writeFile(source, "%YAML 1.1\nPlayerSettings:\n  bundleVersion: '4.6.12-preview.3'\n", "utf8");

    assert.deepEqual(await getVersionMajorMinor("UNITY", source), { major: 4, minor: 6 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TXT finds a version anywhere in the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-txt-handler-"));
  try {
    const source = join(root, "version.txt");
    await writeFile(source, "Release candidate\nartifact = app-12.34.56-rc.7+build.9\n", "utf8");

    assert.deepEqual(await getVersionMajorMinor("TXT", source), { major: 12, minor: 34 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TXT fails when the source contains no version", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-txt-invalid-"));
  try {
    const source = join(root, "version.txt");
    await writeFile(source, "no version here\n", "utf8");

    await assert.rejects(getVersionMajorMinor("TXT", source), /Could not find an X\.Y\.Z version/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JavaScript action inputs support hyphenated and underscore environment names", () => {
  const previousCanonical = process.env["INPUT_VERSION-TYPE"];
  const previousAlias = process.env.INPUT_VERSION_SOURCE;

  try {
    process.env["INPUT_VERSION-TYPE"] = " TXT ";
    process.env.INPUT_VERSION_SOURCE = " version.txt ";

    assert.equal(readActionInput("version-type"), "TXT");
    assert.equal(readActionInput("version-source"), "version.txt");
  } finally {
    if (previousCanonical === undefined) {
      delete process.env["INPUT_VERSION-TYPE"];
    } else {
      process.env["INPUT_VERSION-TYPE"] = previousCanonical;
    }
    if (previousAlias === undefined) {
      delete process.env.INPUT_VERSION_SOURCE;
    } else {
      process.env.INPUT_VERSION_SOURCE = previousAlias;
    }
  }
});

test("working directory resolves relative to GITHUB_WORKSPACE or stays absolute", () => {
  const workspace = join("tmp", "checkout");
  const absoluteProject = resolve(workspace, "AbsoluteProject");
  assert.equal(resolveWorkingDirectory("Project", workspace), resolve(workspace, "Project"));
  assert.equal(resolveWorkingDirectory(absoluteProject, workspace), absoluteProject);
});

test("Git authentication overrides persisted credentials without exposing the token in arguments", () => {
  const remoteUrl = "https://git.example.test/Ci/actions";
  const environment = buildGitAuthEnvironment("secret-token", remoteUrl, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://git.example.test/.extraHeader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic old-credential",
  });

  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_CONFIG_COUNT, "3");
  assert.equal(environment.GIT_CONFIG_KEY_1, `http.${remoteUrl}.extraHeader`);
  assert.equal(environment.GIT_CONFIG_VALUE_1, "");
  assert.equal(environment.GIT_CONFIG_KEY_2, `http.${remoteUrl}.extraHeader`);
  assert.equal(
    environment.GIT_CONFIG_VALUE_2,
    `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token", "utf8").toString("base64")}`,
  );

  const effectiveConfig = spawnSync(
    "git",
    ["config", "--get-urlmatch", "http.extraHeader", remoteUrl],
    { encoding: "utf8", env: environment },
  );
  assert.equal(effectiveConfig.status, 0, effectiveConfig.stderr);
  assert.equal(effectiveConfig.stdout.trim(), environment.GIT_CONFIG_VALUE_2);
});

test("SSH authentication reuses the checkout environment without requiring a token", () => {
  for (const remoteUrl of [
    "ssh://git@git.example.test/Team/Project.git",
    "git@git.example.test:Team/Project.git",
  ]) {
    const environment = buildGitAuthEnvironment("", remoteUrl, {
      GIT_SSH_COMMAND: "ssh -i /checkout/key",
    });

    assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
    assert.equal(environment.GIT_SSH_COMMAND, "ssh -i /checkout/key");
    assert.equal(environment.GIT_CONFIG_COUNT, undefined);
  }
});

test("tagging uses FORGEJO_TOKEN and requires it for HTTP origins", async () => {
  const previousToken = process.env.FORGEJO_TOKEN;
  const root = await mkdtemp(join(tmpdir(), "version-token-test-"));
  const work = join(root, "work");

  try {
    process.env.FORGEJO_TOKEN = "automatic-token";
    await assert.rejects(
      tagVersion({ workingDirectory: join(root, "missing") }),
      /Working directory '.+' is not accessible/u,
    );

    run("git", ["init", work], root);
    run("git", ["remote", "add", "origin", "https://git.example.test/Team/Project.git"], work);
    process.env.FORGEJO_TOKEN = "";
    await assert.rejects(
      tagVersion({ workingDirectory: work }),
      /Expected a non-empty token for an HTTP\(S\) origin/u,
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.FORGEJO_TOKEN;
    } else {
      process.env.FORGEJO_TOKEN = previousToken;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsupported version type fails with its expected handler name", async () => {
  await assert.rejects(
    getVersionMajorMinor("UNKNOWN", "version.txt"),
    /Unsupported version type 'UNKNOWN': handler 'mode\/unknown\.mjs' was not found/u,
  );
});

test("push-tag false returns the next version without creating a local or remote tag", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-no-push-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");

  try {
    run("git", ["init", "--bare", remote], root);
    run("git", ["init", work], root);
    run("git", ["config", "user.name", "Test"], work);
    run("git", ["config", "user.email", "test@example.com"], work);
    await writeFile(join(work, "version.txt"), "0.7.9\n", "utf8");
    run("git", ["add", "version.txt"], work);
    run("git", ["commit", "-m", "Initial"], work);
    run("git", ["tag", "version/0.7.2"], work);
    run("git", ["remote", "add", "origin", remote], work);
    run("git", ["push", "-u", "origin", "HEAD"], work);
    run("git", ["push", "origin", "version/0.7.2"], work);
    await writeFile(join(work, "version.txt"), "0.7.10\n", "utf8");
    run("git", ["add", "version.txt"], work);
    run("git", ["commit", "-m", "Next"], work);
    run("git", ["push", "origin", "HEAD"], work);

    const result = await tagVersion({
      workingDirectory: work,
      token: "test-token",
      versionType: "TXT",
      versionSource: "version.txt",
      pushTag: false,
    });

    assert.deepEqual(result, {
      version: "0.7.3",
      versionTag: "version/0.7.3",
      versionMajor: 0,
      versionMinor: 7,
      versionPatch: 3,
      versionCode: 7003,
    });
    assert.equal(run("git", ["tag", "--points-at", "HEAD"], work), "");
    assert.equal(run("git", ["tag", "-l", "version/0.7.3"], work), "");
    assert.equal(run("git", ["--git-dir", remote, "tag", "-l", "version/0.7.3"], root), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated invocation returns the existing tag without changing Git identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-action-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const githubOutput = join(root, "github-output.txt");
  const previousGithubOutput = process.env.GITHUB_OUTPUT;
  const previousGithubWorkspace = process.env.GITHUB_WORKSPACE;

  try {
    run("git", ["init", "--bare", remote], root);
    run("git", ["init", work], root);
    run("git", ["config", "user.name", "Test"], work);
    run("git", ["config", "user.email", "test@example.com"], work);
    await writeFile(join(work, "pyproject.toml"), "[project]\nname = \"example\"\nversion = \"0.7.42\"\n", "utf8");
    run("git", ["add", "pyproject.toml"], work);
    run("git", ["commit", "-m", "Initial"], work);
    run("git", ["remote", "add", "origin", remote], work);
    run("git", ["push", "-u", "origin", "HEAD"], work);

    process.env.GITHUB_OUTPUT = githubOutput;
    process.env.GITHUB_WORKSPACE = root;
    const first = await tagVersion({
      workingDirectory: "work",
      token: "test-token",
      retries: 1,
      retrySleep: 0,
      versionType: "PY_TOML",
      versionSource: "pyproject.toml",
    });
    const second = await tagVersion({
      workingDirectory: "work",
      token: "test-token",
      retries: 1,
      retrySleep: 0,
      versionType: "PY_TOML",
      versionSource: "missing.toml",
    });

    assert.deepEqual(first, {
      version: "0.7.0",
      versionTag: "version/0.7.0",
      versionMajor: 0,
      versionMinor: 7,
      versionPatch: 0,
      versionCode: 7000,
    });
    assert.deepEqual(second, {
      version: "0.7.0",
      versionTag: "version/0.7.0",
      versionMajor: 0,
      versionMinor: 7,
      versionPatch: 0,
      versionCode: 7000,
    });
    assert.equal(run("git", ["tag", "--points-at", "HEAD"], work), "version/0.7.0");
    assert.equal(run("git", ["config", "user.name"], work), "Test");
    assert.equal(run("git", ["config", "user.email"], work), "test@example.com");

    const output = await readFile(githubOutput, "utf8");
    const expectedSha = run("git", ["rev-parse", "HEAD"], work);
    assert.deepEqual(output.split(/\r?\n/u).filter((line) => line.startsWith("commit=")), [
      `commit=${expectedSha}`,
      `commit=${expectedSha}`,
    ]);
    assert.match(output, /^version_major=0$/mu);
    assert.match(output, /^version_minor=7$/mu);
    assert.match(output, /^version_patch=0$/mu);
    assert.match(output, /^version_code=7000$/mu);
  } finally {
    if (previousGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = previousGithubOutput;
    }
    if (previousGithubWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = previousGithubWorkspace;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("the linked entrypoint uses prefix v when computing, pushing, and reusing tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "version-major-tag-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const outputPath = join(root, "github-output.txt");
  const linkedDirectory = join(root, "action");
  const entrypoint = join(linkedDirectory, "index.mjs");

  function invoke(versionSource = "version.txt", pushTag = "true") {
    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: work,
        GITHUB_OUTPUT: outputPath,
        INPUT_VERSION_TYPE: "TXT",
        INPUT_VERSION_SOURCE: versionSource,
        INPUT_WORKING_DIRECTORY: ".",
        INPUT_PREFIX: "v",
        INPUT_PUSH_TAG: pushTag,
        "INPUT_VERSION-TYPE": "TXT",
        "INPUT_VERSION-SOURCE": versionSource,
        "INPUT_WORKING-DIRECTORY": ".",
        "INPUT_PUSH-TAG": pushTag,
      },
    });
    assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  }

  function remoteCommit(tag) {
    return run("git", ["--git-dir", remote, "rev-parse", `refs/tags/${tag}`], root);
  }

  function updateMajorTag() {
    run("git", ["tag", "--force", "v3", "HEAD"], work);
    run("git", ["push", "--force", "origin", "refs/tags/v3"], work);
  }

  try {
    await symlink(
      fileURLToPath(new URL(".", import.meta.url)),
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    run("git", ["init", "--bare", remote], root);
    run("git", ["init", work], root);
    run("git", ["config", "user.name", "Test"], work);
    run("git", ["config", "user.email", "test@example.com"], work);
    await writeFile(join(work, "version.txt"), "3.0.0\n", "utf8");
    run("git", ["add", "version.txt"], work);
    run("git", ["commit", "-m", "Initial"], work);
    run("git", ["tag", "v3.0.4"], work);
    run("git", ["tag", "version/3.0.99"], work);
    run("git", ["remote", "add", "origin", remote], work);
    run("git", ["push", "-u", "origin", "HEAD", "--tags"], work);
    run("git", ["commit", "--allow-empty", "-m", "Next"], work);
    run("git", ["tag", "version/9.9.9"], work);
    const firstSha = run("git", ["rev-parse", "HEAD"], work);

    invoke("version.txt", "false");
    assert.equal(run("git", ["tag", "-l", "v3.0.5"], work), "");
    assert.equal(run("git", ["--git-dir", remote, "tag", "-l", "v3.0.5"], root), "");
    invoke();
    assert.equal(remoteCommit("v3.0.5"), firstSha);
    updateMajorTag();
    assert.equal(remoteCommit("v3"), firstSha);
    invoke("missing.txt");
    assert.equal(run("git", ["tag", "-l", "v3.0.6"], work), "");

    run("git", ["commit", "--allow-empty", "-m", "Another"], work);
    const secondSha = run("git", ["rev-parse", "HEAD"], work);
    invoke();
    assert.equal(remoteCommit("v3.0.6"), secondSha);
    updateMajorTag();
    assert.equal(remoteCommit("v3"), secondSha);
    assert.equal(remoteCommit("v3.0.5"), firstSha);
    const output = await readFile(outputPath, "utf8");
    assert.match(output, /^version=3\.0\.6$/mu);
    assert.match(output, /^version_tag=v3\.0\.6$/mu);
    assert.match(output, /^version_major=3$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
