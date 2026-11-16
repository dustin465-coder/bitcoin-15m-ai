import assert from "node:assert/strict";
import "./model-core.js";

const model = globalThis.BTCProbabilityModel;
assert.ok(model, "model core must attach to globalThis");
assert.ok(Math.abs(model.studentTCdf(0, 5) - 0.5) < 1e-10, "t CDF at zero should be 0.5");
assert.ok(Math.abs(model.studentTCdf(1, 5) - 0.8183912662) < 1e-6, "t CDF(df=5) at one should match reference value");
assert.ok(Math.abs(model.studentTCdf(-1, 5) - 0.1816087338) < 1e-6, "t CDF should be symmetric");

const now = 1_800_000_000_000;
const candles = [];
let price = 100000;
for (let i = 0; i < 40; i++) {
  const open = price;
  price *= 1 + (i % 2 === 0 ? 0.00008 : -0.00003);
  candles.push({
    time: now - (40 - i) * 60000,
    open,
    close: price,
    high: Math.max(open, price) * 1.0001,
    low: Math.min(open, price) * 0.9999,
    volume: 1,
  });
}
const samples = [];
for (let i = 0; i < 20; i++) {
  samples.push({
    timestamp: now - 19000 + i * 900,
    value: 100010 + i * 0.5,
  });
}
const estimate = model.estimate({
  opening: { value: 100000, timestamp: now - 900000 },
  current: { value: 100020, timestamp: now - 1000 },
  samples,
  minuteCandles: candles,
  decisionAt: now,
  roundEnd: now + 5 * 60000,
});
assert.equal(estimate.valid, true, "synthetic market data should produce an estimate");
assert.ok(estimate.probabilityUp > 0.5, "positive price-to-beat gap should lean UP");
assert.ok(estimate.probabilityDown < 0.5, "positive price-to-beat gap should not lean DOWN");
assert.ok(estimate.probabilityUp + estimate.probabilityDown > 0.99999, "probabilities should sum to one");
console.log("V4 probability model checks passed.");
