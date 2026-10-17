import { appendFileSync } from "node:fs";

export default async function* testCounts(source) {
  for await (const { type, data } of source) {
    // Ignore per-file summaries; only export the final cumulative counts.
    if (type !== "test:summary" || data.file !== undefined || !process.env.GITHUB_OUTPUT) continue;

    const { passed, tests } = data.counts;
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, `message=${passed}/${tests}\n`);
    } catch {
      yield "::warning::Could not export test counts for the badge.\n";
    }
  }
}
