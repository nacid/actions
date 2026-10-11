import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findFiles } from "./index.mjs";

async function fixture(t, names) {
  const root = await mkdtemp(join(tmpdir(), "files-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of names) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture", "utf8");
  }
  return root;
}

test("a mask returns sorted basenames and excludes directories and nested files", async (t) => {
  const workspace = await fixture(t, ["dist/xyz.apk", "dist/asd.apk", "dist/nested/aaa.apk", "dist/readme.txt"]);
  await mkdir(join(workspace, "dist/directory.apk"));
  assert.deepEqual(await findFiles({ workspace, pattern: "dist/*.apk" }), {
    first: "asd.apk", last: "xyz.apk", all: "asd.apk,xyz.apk", count: 2,
  });
});

test("recursive masks include zero levels, keep duplicate names, and sort by path", async (t) => {
  const workspace = await fixture(t, ["dist/z.apk", "dist/a/z.apk", "dist/a/deep/b.apk"]);
  assert.deepEqual(await findFiles({ workspace, pattern: "dist/**/**/*.apk" }), {
    first: "b.apk", last: "z.apk", all: "b.apk,z.apk,z.apk", count: 3,
  });
  assert.equal((await findFiles({ workspace, pattern: "dist/**" })).count, 3);
});

test("question marks, literal regex characters, and backslash separators", async (t) => {
  const workspace = await fixture(t, ["dist/app(1).apk", "dist/app(22).apk", "dist/app1.apk"]);
  assert.deepEqual(await findFiles({ workspace, pattern: "dist\\app(?).apk" }), {
    first: "app(1).apk", last: "app(1).apk", all: "app(1).apk", count: 1,
  });
});

test("working-directory, absolute patterns, spaces and hidden files", async (t) => {
  const workspace = await fixture(t, ["Project/dist/my app.apk", "Project/dist/.hidden.apk"]);
  const expected = { first: ".hidden.apk", last: "my app.apk", all: ".hidden.apk,my app.apk", count: 2 };
  assert.deepEqual(await findFiles({ workspace, workingDirectory: "Project", pattern: "dist/*.apk" }), expected);
  assert.deepEqual(await findFiles({ workspace, pattern: join(workspace, "Project/dist/*.apk") }), expected);
});

test("no matches and missing mask directories produce empty outputs", async (t) => {
  const workspace = await fixture(t, ["dist/file.txt"]);
  for (const pattern of ["dist/*.apk", "missing/**/*.apk", "dist/file.txt/*.apk"]) {
    assert.deepEqual(await findFiles({ workspace, pattern, minimum: 0 }), { first: "", last: "", all: "", count: 0 });
  }
  await assert.rejects(findFiles({ workspace, pattern: " " }), /Input 'pattern' is required/u);
  await assert.rejects(findFiles({ workspace, pattern: "*", workingDirectory: "missing" }), { code: "ENOENT" });
});

test("direct and linked entry points read inputs and write all four workflow outputs", async (t) => {
  const workspace = await fixture(t, ["Project/dist/asd.apk", "Project/dist/xyz.apk"]);
  const output = join(workspace, "output.txt");
  const env = { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output, INPUT_PATTERN: "dist/*.apk", INPUT_MINIMUM: "" };
  delete env["INPUT_WORKING-DIRECTORY"];
  env.INPUT_WORKING_DIRECTORY = "Project";
  const linkedDirectory = join(workspace, "action");
  await symlink(
    fileURLToPath(new URL(".", import.meta.url)),
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const entry of [fileURLToPath(new URL("./index.mjs", import.meta.url)), join(linkedDirectory, "index.mjs")]) {
    await rm(output, { force: true });
    env.INPUT_PATTERN = "dist/*.apk";
    const result = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const content = await readFile(output, "utf8");
    const outputs = Object.fromEntries([...content.matchAll(/^(\w+)<<(files_[\w-]+)\n([\s\S]*?)\n\2\n/gmu)].map((match) => [match[1], match[3]]));
    assert.deepEqual(outputs, { first: "asd.apk", last: "xyz.apk", all: "asd.apk,xyz.apk", count: "2" });

    env.INPUT_PATTERN = "";
    const invalid = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Input 'pattern' is required/u);
  }
});

test("minimum defaults to one, accepts an exact count, and rejects insufficient matches", async (t) => {
  const workspace = await fixture(t, ["dist/asd.apk", "dist/xyz.apk"]);
  await assert.rejects(findFiles({ workspace, pattern: "missing/*.apk" }), {
    message: "Found 0 files matching 'missing/*.apk', but minimum is 1",
  });
  assert.equal((await findFiles({ workspace, pattern: "dist/*.apk", minimum: "2" })).count, 2);
  await assert.rejects(findFiles({ workspace, pattern: "dist/*.apk", minimum: 3 }), {
    message: "Found 2 files matching 'dist/*.apk', but minimum is 3",
  });
  for (const minimum of [-1, "abc", 1.5, "", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(findFiles({ workspace, pattern: "dist/*.apk", minimum }), /Input 'minimum' must be a non-negative safe integer/u);
  }
});

test("the entry point fails before writing outputs when minimum is not met", async (t) => {
  const workspace = await fixture(t, ["dist/asd.apk"]);
  const output = join(workspace, "output.txt");
  const env = {
    ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output,
    INPUT_PATTERN: "dist/*.apk", INPUT_MINIMUM: "2",
    "INPUT_WORKING-DIRECTORY": ".",
  };
  const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Found 1 files matching 'dist\/\*\.apk', but minimum is 2/u);
  await assert.rejects(readFile(output), { code: "ENOENT" });

  env.INPUT_PATTERN = "missing/*.apk";
  env.INPUT_MINIMUM = "";
  const defaultResult = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
  assert.equal(defaultResult.status, 1);
  assert.match(defaultResult.stderr, /minimum is 1/u);

  env.INPUT_MINIMUM = "0";
  const allowed = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(await readFile(output, "utf8"), /^count<<[^\n]+\n0\n/mu);
});
