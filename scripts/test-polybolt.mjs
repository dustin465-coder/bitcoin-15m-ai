import assert from "node:assert/strict";
import fs from "node:fs/promises";

const recorder = await fs.readFile("scripts/record-checkpoints.mjs", "utf8");
const worker = await fs.readFile("cloudflare/polybolt-relay.js", "utf8");
const dashboard = await fs.readFile("index.html", "utf8");

assert.ok(recorder.includes("wss://ws-live-v2.polymarket.com/ws"), "recorder must use the PolyBolt endpoint");
assert.ok(recorder.includes('op: "auth"'), "recorder must authenticate");
assert.ok(recorder.includes('await waitFor(authAck'), "recorder must wait for auth acknowledgement");
assert.ok(recorder.includes('await waitFor(subscriptionAck'), "recorder must wait for subscription acknowledgement");
assert.ok(recorder.includes('await waitFor(firstSample'), "recorder must require a real TWAP sample");
assert.ok(recorder.includes('filter: { symbol: "btcusd", window_seconds: 60 }'), "recorder must request BTC/USD 60-second TWAP");
assert.ok(recorder.includes("Number(row.full_accuracy_value ?? row.value)"), "recorder must read PolyBolt decimal values directly");
assert.ok(recorder.includes("feedDiagnostics"), "recorder must save feed health diagnostics");

assert.ok(worker.includes("wss://ws-live-v2.polymarket.com/ws"), "relay must use the PolyBolt endpoint");
assert.ok(worker.includes("env.POLYMARKET_API_SECRET"), "relay must read credentials from server-side secrets");
assert.ok(worker.includes("Origin"), "relay must check the requesting website origin");
assert.ok(worker.includes('op: "auth"'), "relay must authenticate upstream");
assert.ok(worker.includes('op: "subscribe"'), "relay must subscribe upstream");
assert.ok(worker.includes('window_seconds: 60'), "relay must request 60-second TWAP");
assert.ok(worker.includes('status(server, "subscribed")'), "relay must report successful subscription");

assert.ok(dashboard.includes('const POLYBOLT_RELAY_URL=""'), "dashboard must expose a blank relay URL setting");
assert.ok(dashboard.includes('msg.channel!=="price.crypto.twap"'), "dashboard must parse PolyBolt TWAP messages");
assert.ok(dashboard.includes('handleTwapSample({'), "dashboard must pass PolyBolt sample payloads into the TWAP handler");
assert.ok(!dashboard.includes("POLYMARKET_API_SECRET"), "dashboard must never contain the API secret name");

console.log("PolyBolt migration checks passed.");
