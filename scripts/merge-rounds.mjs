import fs from "node:fs/promises";

const incomingPath = process.argv[2] || "/tmp/collector-rounds.json";
const local = JSON.parse(await fs.readFile(incomingPath, "utf8"));

let remote = { version: 1, rounds: [] };
try {
  remote = JSON.parse(await fs.readFile("data/rounds.json", "utf8"));
} catch {}

const byKey = new Map((remote.rounds || []).map((round) => [
  String(round.roundStart) + "|" + String(round.modelVersion || "legacy"),
  round,
]));

for (const round of (local.rounds || [])) {
  const key = String(round.roundStart) + "|" + String(round.modelVersion || "legacy");
  const old = byKey.get(key) || {};
  const merged = { ...old, ...round };

  // Never erase an already captured or resolved value with a later null.
  for (const field of [
    "openingTwap",
    "openingTwapTimestamp",
    "signalTwap",
    "signalTwapTimestamp",
    "actualOutcome",
    "result",
    "resolvedAt",
  ]) {
    if (round[field] == null && old[field] != null) merged[field] = old[field];
  }
  byKey.set(key, merged);
}

const rounds = [...byKey.values()]
  .sort((a, b) => a.roundStart - b.roundStart)
  .slice(-600);

const stamps = [remote.updatedAt, local.updatedAt].filter(Boolean).sort();
const output = {
  version: 2,
  modelVersion: local.modelVersion || remote.modelVersion || "legacy",
  updatedAt: stamps.at(-1) || new Date().toISOString(),
  schedule: local.schedule || remote.schedule,
  rounds,
};

await fs.mkdir("data", { recursive: true });
await fs.writeFile("data/rounds.json", JSON.stringify(output, null, 2) + "\n");
