import fs from "node:fs/promises";

const incomingPath = process.argv[2] || "/tmp/collector-rounds.json";
const local = JSON.parse(await fs.readFile(incomingPath, "utf8"));

let remote = { version: 1, rounds: [] };
try {
  remote = JSON.parse(await fs.readFile("data/rounds.json", "utf8"));
} catch {}

const byStart = new Map((remote.rounds || []).map((round) => [round.roundStart, round]));

for (const round of (local.rounds || [])) {
  const old = byStart.get(round.roundStart) || {};
  const merged = { ...old, ...round };

  // Never erase an already captured or resolved value with a later null.
  for (const key of [
    "openingTwap",
    "openingTwapTimestamp",
    "closingTwap",
    "closingTwapTimestamp",
    "actualOutcome",
    "result",
    "resolvedAt",
  ]) {
    if (round[key] == null && old[key] != null) merged[key] = old[key];
  }

  byStart.set(round.roundStart, merged);
}

const rounds = [...byStart.values()]
  .sort((a, b) => a.roundStart - b.roundStart)
  .slice(-300);

const stamps = [remote.updatedAt, local.updatedAt].filter(Boolean).sort();
const output = {
  version: 1,
  updatedAt: stamps.at(-1) || new Date().toISOString(),
  schedule: "GitHub Actions scheduled after each 15-minute boundary; predictions reconstructed as-of boundary",
  rounds,
};

await fs.mkdir("data", { recursive: true });
await fs.writeFile("data/rounds.json", JSON.stringify(output, null, 2) + "\n");
