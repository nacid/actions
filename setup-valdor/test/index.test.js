const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const tar = require("tar");

const {
  buildPackageUrl,
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
