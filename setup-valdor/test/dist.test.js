const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");
const tar = require("tar");

const execFileAsync = promisify(execFile);

test("the bundled action works with Forgejo-compatible environment variables", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "valdor-dist-fixture-")
  );
  const destination = await fs.mkdtemp(
    path.join(os.tmpdir(), "valdor-dist-destination-")
  );
  t.after(async () => {
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
    await fs.rm(destination, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(fixtureDirectory, "from-dist.txt"), "complete");
  await fs.writeFile(
    path.join(fixtureDirectory, "envs.json"),
    JSON.stringify({
      toolPath: "{{root}}/tools",
      "extras-cache": "{{extras}}/cache",
    })
  );
  const archivePath = path.join(fixtureDirectory, "fixture.tar");
  await tar.create(
    {
      cwd: fixtureDirectory,
      file: archivePath,
    },
    ["from-dist.txt", "envs.json"]
  );
  const archive = await fs.readFile(archivePath);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/oidc") {
      assert.equal(request.headers.authorization, "Bearer request-token");
      assert.equal(url.searchParams.get("audience"), "valdor-audience");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ value: "oidc-jwt" }));
      return;
    }

    assert.equal(url.pathname, "/packages/codeberg.org");
    assert.equal(url.searchParams.get("branch"), "main");
    assert.equal(request.headers.authorization, "Bearer oidc-jwt");
    response.end(archive);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const actionPath = path.resolve(__dirname, "../dist/index.js");
  const environmentFile = path.join(destination, "runner-env");
  await fs.writeFile(environmentFile, "");

  const { stdout } = await execFileAsync(process.execPath, [actionPath], {
    cwd: destination,
    env: {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?request=1`,
      FORGEJO_SERVER_URL: "https://codeberg.org",
      FORGEJO_WORKSPACE: destination,
      GITHUB_ENV: environmentFile,
      "INPUT_VALDOR-URL": `http://127.0.0.1:${port}/packages`,
      "INPUT_VALDOR-AUD": "valdor-audience",
      INPUT_FORGE: "",
      INPUT_VERSION: "",
      INPUT_TAG: "",
      INPUT_BRANCH: "main",
      INPUT_COMMIT: "",
    },
  });

  assert.equal(
    await fs.readFile(path.join(destination, "from-dist.txt"), "utf8"),
    "complete"
  );
  await assert.rejects(fs.access(path.join(destination, "envs.json")), {
    code: "ENOENT",
  });

  const exportedEnvironment = await fs.readFile(environmentFile, "utf8");
  assert.match(exportedEnvironment, /TOOL_PATH<</);
  assert.match(exportedEnvironment, /EXTRAS_CACHE<</);
  assert.ok(exportedEnvironment.includes(`${path.resolve(destination)}/tools`));
  assert.ok(
    exportedEnvironment.includes(
      `${path.join(path.resolve(destination), "extras")}/cache`
    )
  );
  assert.match(
    stdout,
    /Created environment variables:\r?\nTOOL_PATH\r?\nEXTRAS_CACHE/
  );
});
