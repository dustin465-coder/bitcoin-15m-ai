import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const html = await fs.readFile("index.html", "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
const main = scripts.map(match => match[1]).find(source => source.includes("const probabilityModel=window.BTCProbabilityModel"));
assert.ok(main, "main dashboard script must exist");
new vm.Script(main, { filename: "index.html:inline-script" });

for (const id of [
  "decisionProbability",
  "v4Rounds",
  "v4Checkpoints",
  "v4Buys",
  "v4Accuracy",
  "v4UpAccuracy",
  "v4DownAccuracy",
  "v4NoTrade",
  "v4Brier",
  "checkpointRows",
  "calibrationRows",
  "latestCheckpointRows",
]) {
  assert.ok(html.includes('id="' + id + '"'), "missing dashboard element: " + id);
}
assert.ok(html.includes('./scripts/model-core.js'), "shared probability model must load before dashboard code");

assert.ok(main.includes("function readSignalState()"), "dashboard must remember the latest BUY suggestion locally");
assert.ok(main.includes('action="HOLD "+state.side'), "dashboard must provide a HOLD signal");
assert.ok(main.includes('action="CASH OUT "+state.side'), "dashboard must provide a CASH OUT signal");
assert.ok(main.includes("heldProbability<0.55"), "dashboard must use a defined weakening threshold for market-based exit signals");
assert.ok(main.includes("dashboard does not know whether you bought"), "dashboard must disclose that it cannot confirm a real position");

console.log("Dashboard inline JavaScript and V4 elements passed.");
