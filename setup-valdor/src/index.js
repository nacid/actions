const core = require("@actions/core");
const { createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const tar = require("tar");

const SELECTOR_INPUTS = ["version", "tag", "branch", "commit"];

function parseForge(serverUrl) {
  if (!serverUrl) {
    throw new Error(
      "The forge input is empty and GITHUB_SERVER_URL is not available"
    );
  }

  try {
    return new URL(serverUrl).host;
  } catch {
    throw new Error(`GITHUB_SERVER_URL is not a valid URL: ${serverUrl}`);
  }
}

function buildPackageUrl(valdorUrl, forge, selectors = {}) {
  let url;

  try {
    const baseUrl = valdorUrl.endsWith("/") ? valdorUrl : `${valdorUrl}/`;
    url = new URL(encodeURIComponent(forge), baseUrl);
  } catch {
    throw new Error(`valdor-url is not a valid URL: ${valdorUrl}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("valdor-url must use the http or https protocol");
  }

  for (const name of SELECTOR_INPUTS) {
    if (selectors[name]) {
      url.searchParams.set(name, selectors[name]);
    }
  }

  return url;
}

async function responseError(response) {
  const body = await response.text();
  const suffix = body ? `: ${body.slice(0, 4096)}` : "";
  return new Error(
    `Valdor returned HTTP ${response.status} ${response.statusText}${suffix}`
  );
}

function normalizeEnvName(key) {
  let name = key
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase();

  if (!name) {
    throw new Error(`envs.json key ${JSON.stringify(key)} has no valid characters`);
  }

  if (/^[0-9]/.test(name)) {
    name = `_${name}`;
  }

  return name;
}

function expandEnvValue(value, workspace) {
  const root = path.resolve(workspace);
  const extras = path.join(root, "extras");

  return value
    .replaceAll("{{root}}", root)
    .replaceAll("{{extras}}", extras);
}

async function exportEnvs({
  directory,
  workspace = directory,
  setSecret = (value) => core.setSecret(value),
  exportVariable = (name, value) => core.exportVariable(name, value),
  info = (message) => core.info(message),
}) {
  const envsPath = path.join(directory, "envs.json");
  let source;

  try {
    source = await fs.readFile(envsPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  await fs.unlink(envsPath);

  let envs;
  try {
    envs = JSON.parse(source);
  } catch {
    throw new Error("envs.json is not valid JSON");
  }

  if (envs === null || Array.isArray(envs) || typeof envs !== "object") {
    throw new Error("envs.json must contain a flat JSON object");
  }

  const normalizedNames = new Map();
  const resolvedEnvs = [];

  for (const [key, value] of Object.entries(envs)) {
    if (typeof value !== "string") {
      throw new Error(`envs.json value for ${JSON.stringify(key)} must be a string`);
    }

    const name = normalizeEnvName(key);
    const previousKey = normalizedNames.get(name);
    if (previousKey !== undefined) {
      throw new Error(
        `envs.json keys ${JSON.stringify(previousKey)} and ${JSON.stringify(key)} both normalize to ${name}`
      );
    }

    normalizedNames.set(name, key);
    resolvedEnvs.push([name, expandEnvValue(value, workspace)]);
  }

  for (const [, value] of resolvedEnvs) {
    setSecret(value);
  }

  for (const [name, value] of resolvedEnvs) {
    exportVariable(name, value);
  }

  if (resolvedEnvs.length > 0) {
    info("Created environment variables:");
    for (const [name] of resolvedEnvs) {
      info(name);
    }
  }

  return resolvedEnvs.map(([name]) => name);
}

async function run({
  getInput = (name, options) => core.getInput(name, options),
  getIDToken = (audience) => core.getIDToken(audience),
  request = fetch,
  serverUrl =
    process.env.FORGEJO_SERVER_URL || process.env.GITHUB_SERVER_URL,
  destination = process.cwd(),
  workspace =
    process.env.FORGEJO_WORKSPACE ||
    process.env.GITHUB_WORKSPACE ||
    destination,
} = {}) {
  const valdorUrl = getInput("valdor-url", { required: true });
  const audience = getInput("valdor-aud", { required: true });
  const forgeInput = getInput("forge");
  const forge = forgeInput || parseForge(serverUrl);
  const selectors = Object.fromEntries(
    SELECTOR_INPUTS.map((name) => [name, getInput(name)])
  );
  const packageUrl = buildPackageUrl(valdorUrl, forge, selectors);

  core.info(`Requesting an OIDC token for audience ${audience}`);
  const jwt = await getIDToken(audience);

  core.info(`Downloading package from ${packageUrl}`);
  const response = await request(packageUrl, {
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "valdor-"));
  const archivePath = path.join(tempDirectory, "package.tar");

  try {
    if (!response.body) {
      throw new Error("Valdor returned an empty response body");
    }

    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(archivePath)
    );

    core.info("Extracting package into the workspace");
    await tar.extract({
      file: archivePath,
      cwd: destination,
      strict: true,
    });

    await exportEnvs({
      directory: destination,
      workspace,
    });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((error) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}

module.exports = {
  SELECTOR_INPUTS,
  buildPackageUrl,
  expandEnvValue,
  exportEnvs,
  normalizeEnvName,
  parseForge,
  responseError,
  run,
};
