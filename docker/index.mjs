import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { publishDockerImage } from "./docker.mjs";

async function main() {
  await publishDockerImage();
}

const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
