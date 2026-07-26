import { publishDockerImage } from "./docker.mjs";

async function main() {
  await publishDockerImage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
