const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tar = require("tar");

const {
  buildPackageUrl,
  expandEnvValue,
  exportEnvs,
  parseForge,
  responseError,
  run,
} = require("../src/index");

test("parseForge returns the host, including a non-default port", () => {
  assert.equal(parseForge("https://github.example.com:8443"), "github.example.com:8443");
});

test("buildPackageUrl appends forge and only non-empty selectors", () => {
  const url = buildPackageUrl("https://valdor.example/api", "github.com", {
    version: "1.2.3",
    tag: "",
    branch: "feature/a b",
  });

  assert.equal(
    url.toString(),
    "https://valdor.example/api/github.com?version=1.2.3&branch=feature%2Fa+b"
  );
});

test("buildPackageUrl preserves a trailing base path", () => {
  const url = buildPackageUrl(
    "https://valdor.example/api/",
    "github.example.com",
    {}
  );

  assert.equal(url.toString(), "https://valdor.example/api/github.example.com");
});

test("responseError includes a bounded response body", async () => {
  const response = new Response("details", {
    status: 403,
    statusText: "Forbidden",
  });

  await assert.rejects(
    async () => {
      throw await responseError(response);
    },
    /Valdor returned HTTP 403 Forbidden: details/
  );
});

test("expandEnvValue replaces root and extras placeholders", () => {
  const workspace = path.resolve("workspace");

  assert.equal(
    expandEnvValue("{{root}};{{extras}};{{root}}", workspace),
    `${workspace};${path.join(workspace, "extras")};${workspace}`
  );
});

test("exportEnvs removes envs.json, masks only secrets, creates outputs, and preserves names", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "valdor-envs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envsPath = path.join(directory, "envs.json");
  await fs.writeFile(
    envsPath,
    JSON.stringify({
      toolPath: {
        secret: true,
        value: "{{root}}/tools",
      },
      "extras-cache": {
        secret: false,
        value: "{{extras}}/cache",
      },
    })
  );

  const events = [];
  const names = await exportEnvs({
    directory,
    workspace: directory,
    setSecret: (value) => events.push(["secret", value]),
    setOutput: (name, value) => events.push(["output", name, value]),
    info: (message) => events.push(["info", message]),
  });
  const root = path.resolve(directory);
  const toolPath = `${root}/tools`;
  const extrasCache = `${path.join(root, "extras")}/cache`;

  assert.deepEqual(names, ["toolPath", "extras-cache"]);
  assert.deepEqual(events, [
    ["secret", toolPath],
    ["output", "toolPath", toolPath],
    ["output", "extras-cache", extrasCache],
    ["info", "Created step outputs:"],
    ["info", "toolPath"],
    ["info", "extras-cache"],
  ]);
  await assert.rejects(fs.access(envsPath), { code: "ENOENT" });
});

test("exportEnvs preserves distinct keys that previously normalized to the same name", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "valdor-env-collision-")
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envsPath = path.join(directory, "envs.json");
  await fs.writeFile(
    envsPath,
    JSON.stringify({
      "some-key": { secret: false, value: "one" },
      someKey: { secret: false, value: "two" },
    })
  );

  const outputs = [];
  await exportEnvs({
    directory,
    setOutput: (name, value) => outputs.push([name, value]),
    info: () => {},
  });
  assert.deepEqual(outputs, [["some-key", "one"], ["someKey", "two"]]);
  await assert.rejects(fs.access(envsPath), { code: "ENOENT" });
});

test("exportEnvs rejects entries without a boolean secret flag", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "valdor-env-invalid-")
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "envs.json"),
    JSON.stringify({
      token: { value: "not-marked" },
    })
  );

  await assert.rejects(
    exportEnvs({ directory }),
    /secret for "token" must be a boolean/
  );
});

test("run requests OIDC, downloads the archive, and extracts it", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "valdor-fixture-")
  );
  const destination = await fs.mkdtemp(
    path.join(os.tmpdir(), "valdor-destination-")
  );
  t.after(async () => {
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
    await fs.rm(destination, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(fixtureDirectory, "downloaded.txt"), "ok");
  const archivePath = path.join(fixtureDirectory, "fixture.tar");
  await tar.create(
    {
      cwd: fixtureDirectory,
      file: archivePath,
    },
    ["downloaded.txt"]
  );
  const archive = await fs.readFile(archivePath);

  const inputs = {
    "valdor-url": "https://valdor.example/packages",
    "valdor-aud": "valdor",
    forge: "",
    version: "1.2.3",
    tag: "",
    branch: "",
    commit: "",
  };
  let requestedAudience;
  let requestedUrl;
  let authorization;

  await run({
    destination,
    serverUrl: "https://codeberg.org",
    getInput: (name) => inputs[name],
    getIDToken: async (audience) => {
      requestedAudience = audience;
      return "oidc-token";
    },
    request: async (url, options) => {
      requestedUrl = url.toString();
      authorization = options.headers.Authorization;
      assert.equal(Object.hasOwn(options.headers, "X-Valdor-Profile"), false);
      return new Response(archive);
    },
  });

  assert.equal(requestedAudience, "valdor");
  assert.equal(
    requestedUrl,
    "https://valdor.example/packages/codeberg.org?version=1.2.3"
  );
  assert.equal(authorization, "Bearer oidc-token");
  assert.equal(
    await fs.readFile(path.join(destination, "downloaded.txt"), "utf8"),
    "ok"
  );
});
