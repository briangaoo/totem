// Run async thunks with bounded concurrency and a small random pre-delay, so a
// fan-out of identical data requests doesn't leave the process as a single
// millisecond-aligned burst (a pattern no human-driven app produces, and an
// easy heuristic to flag). The jitter is cosmetic request timing only — not
// security-sensitive — but crypto.randomInt keeps the codebase free of
// Math.random.
import { randomInt } from "node:crypto";

export async function runPaced<T>(
  thunks: Array<() => Promise<T>>,
  opts: { concurrency?: number; jitterMaxMs?: number } = {},
): Promise<T[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const jitterMaxMs = opts.jitterMaxMs ?? 120;
  const results = new Array<T>(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      if (jitterMaxMs > 0) await new Promise((r) => setTimeout(r, randomInt(0, jitterMaxMs + 1)));
      results[i] = await thunks[i]!();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, thunks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
