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
    ["info", "toolPath=***"],
    ["info", `extras-cache=${extrasCache}`],
  ]);
  await assert.rejects(fs.access(envsPath), { code: "ENOENT" });
});

test("exportEnvs logs multiline secrets on one line and preserves their output values", async (t) => {
  for (const newline of ["\n", "\r\n"]) {
    await t.test(JSON.stringify(newline), async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "valdor-multiline-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const value = ["-----BEGIN PRIVATE KEY-----", "key-material", "-----END PRIVATE KEY-----", ""].join(newline);
      await fs.writeFile(
        path.join(directory, "envs.json"),
        JSON.stringify({ ssh: { secret: true, value } })
      );

      const secrets = [];
      const outputs = [];
      const messages = [];
      await exportEnvs({
        directory,
        setSecret: (value) => secrets.push(value),
        setOutput: (name, value) => outputs.push([name, value]),
        info: (message) => messages.push(message),
      });

      assert.deepEqual(secrets, [value]);
      assert.deepEqual(outputs, [["ssh", value]]);
      assert.deepEqual(messages, ["Created step outputs:", "ssh=***"]);
    });
  }
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

test("exportEnvs rejects the reserved files output before publishing any outputs", async (t) => {
  for (const name of ["files", "FILES"]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "valdor-reserved-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(directory, "envs.json"),
      JSON.stringify({
        toolPath: { secret: false, value: "{{root}}/tools" },
        [name]: { secret: false, value: "conflict" },
      })
    );
    const outputs = [];

    await assert.rejects(
      exportEnvs({
        directory,
        setOutput: (...args) => outputs.push(args),
      }),
      /output name "files" is reserved/
    );
    assert.deepEqual(outputs, []);
  }
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
    extras: "",
    forge: "",
    version: "1.2.3",
    tag: "",
    branch: "",
    commit: "",
  };
  let requestedAudience;
  let requestedUrl;
  let authorization;
  const outputs = [];

  await run({
    destination,
    setOutput: (...args) => outputs.push(args),
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
      assert.equal(Object.hasOwn(options.headers, "X-Valdor-Extras"), false);
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
  assert.deepEqual(outputs, [["files", "{}"]]);
});

async function createPackageRunner(t, contents, existing = {}) {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "valdor-files-"));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "valdor-files-destination-"));
  t.after(async () => {
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
    await fs.rm(destination, { recursive: true, force: true });
  });
  for (const [directory, files] of [[fixtureDirectory, contents], [destination, existing]]) {
    for (const [name, value] of Object.entries(files)) {
      const filePath = path.join(directory, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, value);
    }
  }
  const archivePath = path.join(fixtureDirectory, "fixture.tar");
  await tar.create({ cwd: fixtureDirectory, file: archivePath }, Object.keys(contents));
  const archive = await fs.readFile(archivePath);
  const outputs = [];
  const inputs = {
    "valdor-url": "https://valdor.example/packages",
    "valdor-aud": "valdor",
    extras: "common.p12",
  };

  return {
    destination,
    outputs,
    run: () => run({
      destination,
      workspace: destination,
      serverUrl: "https://github.com",
      getInput: (name) => inputs[name] || "",
      getIDToken: async () => "oidc-token",
      setOutput: (...args) => outputs.push(args),
      request: async (_url, options) => {
        assert.equal(options.headers["X-Valdor-Extras"], "common.p12");
        return new Response(archive);
      },
    }),
  };
}

test("run exports absolute extras paths by basename and keeps envs.json separate", async (t) => {
  const certificate = Buffer.from([0, 255, 1, 128]);
  const fixture = await createPackageRunner(t, {
    "extras/certs/common.p12": certificate,
    "extras/name with spaces.txt": "text",
    "extras/__proto__": "ordinary filename",
    "extras/envs.json": "excluded from files",
    "extras/nested/envs.json": "also excluded",
    "envs.json": JSON.stringify({
      certificatePath: { secret: false, value: "{{extras}}/certs/common.p12" },
    }),
    "outside.txt": "outside extras",
    "extras-other/not-an-extra.txt": "outside extras",
  }, {
    "extras/stale.txt": "from an earlier run",
    "extras/certs/common.p12": "old content",
  });

  await fixture.run();

  const outputs = Object.fromEntries(fixture.outputs);
  const files = JSON.parse(outputs.files);
  assert.deepEqual(files, {
    "common.p12": path.join(fixture.destination, "extras/certs/common.p12"),
    "name with spaces.txt": path.join(fixture.destination, "extras/name with spaces.txt"),
    ["__proto__"]: path.join(fixture.destination, "extras/__proto__"),
  });
  assert.equal(outputs.certificatePath, `${path.join(fixture.destination, "extras")}/certs/common.p12`);
  assert.deepEqual(await fs.readFile(files["common.p12"]), certificate);
  await assert.rejects(fs.access(path.join(fixture.destination, "envs.json")), { code: "ENOENT" });
});

test("run rejects duplicate extras basenames instead of publishing an ambiguous map", async (t) => {
  const fixture = await createPackageRunner(t, {
    "extras/first/common.p12": "first certificate",
    "extras/second/common.p12": "second certificate",
  });

  await assert.rejects(fixture.run(), /Duplicate extras filename "common.p12"/);
  assert.deepEqual(fixture.outputs, []);
});
