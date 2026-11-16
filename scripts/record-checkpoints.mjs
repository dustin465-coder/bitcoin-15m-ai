import fs from "node:fs/promises";
import "./model-core.js";

const DATA_FILE = "data/rounds.json";
const ROUND_MS = 15 * 60 * 1000;
const MODEL_VERSION = "v4-student-t-checkpoints";
const STOP_OFFSET_MS = 13.5 * 60 * 1000;
const OPEN_TOLERANCE_MS = 5000;
const CHECKPOINTS = [
  { key: "m3", label: "3 min", offsetMs: 3 * 60 * 1000 },
  { key: "m5", label: "5 min", offsetMs: 5 * 60 * 1000 },
  { key: "m8", label: "8 min", offsetMs: 8 * 60 * 1000 },
  { key: "m10", label: "10 min", offsetMs: 10 * 60 * 1000 },
  { key: "m12", label: "12 min", offsetMs: 12 * 60 * 1000 },
  { key: "m13_5", label: "13.5 min", offsetMs: 13.5 * 60 * 1000 },
];
const GRANULARITIES = [60, 300, 3600];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const probabilityEngine = globalThis.BTCProbabilityModel;

if (!probabilityEngine || typeof probabilityEngine.estimate !== "function") {
  throw new Error("Shared probability model failed to load.");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "BTC-AI-Lab-V4-Checkpoint-Recorder/1.0" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return response.json();
}

async function getServerOffset() {
  const time = await fetchJson("https://api.exchange.coinbase.com/time");
  const serverMs = time.epoch ? Number(time.epoch) * 1000 : Date.parse(time.iso);
  if (!Number.isFinite(serverMs)) throw new Error("Coinbase server time was invalid");
  return serverMs - Date.now();
}

async function getCandles(granularity) {
  const url = "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=" + granularity;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error("Coinbase returned invalid " + granularity + "s candles");
  return rows.map((row) => ({
    time: Number(row[0]) * 1000,
    low: Number(row[1]),
    high: Number(row[2]),
    open: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

function completedAsOf(data, seconds, at) {
  return data.filter((c) => c.time + seconds * 1000 <= at);
}

function ema(values, period) {
  let value = values[0];
  const k = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function emaLine(values, period) {
  const out = [];
  let value = values[0];
  const k = 2 / (period + 1);
  for (let i = 0; i < values.length; i++) {
    value = i === 0 ? values[i] : values[i] * k + value * (1 - k);
    out.push(value);
  }
  return out;
}

function rsi(values) {
  if (values.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - 14; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function macdHistogram(values) {
  const fast = emaLine(values, 12);
  const slow = emaLine(values, 26);
  const line = fast.map((v, i) => v - slow[i]);
  const signal = emaLine(line.slice(-9), 9);
  return line.at(-1) - signal.at(-1);
}

function bollinger(values) {
  const sample = values.slice(-20);
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const sd = Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length);
  return { mid: mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
}

function atr(data) {
  if (!data || data.length < 2) return 0;
  const ranges = [];
  for (let i = 1; i < data.length; i++) {
    const current = data[i], previous = data[i - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  const tail = ranges.slice(-14);
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
}

function vwap(data) {
  const sample = data.slice(-96);
  let priceVolume = 0, volume = 0;
  for (const c of sample) {
    const typical = (c.high + c.low + c.close) / 3;
    priceVolume += typical * c.volume;
    volume += c.volume;
  }
  return volume ? priceVolume / volume : data.at(-1).close;
}

function timeframeDirection(data) {
  if (!data || data.length < 25) return "N/A";
  const closes = data.map((c) => c.close);
  return ema(closes.slice(-25), 9) > ema(closes.slice(-25), 21) ? "UP" : "DOWN";
}

function analyze(data, otherFrames) {
  if (!data || data.length < 30) return null;
  const closes = data.map((c) => c.close);
  const last = data.at(-1);
  const ema9 = ema(closes.slice(-40), 9);
  const ema21 = ema(closes.slice(-40), 21);
  const strength = rsi(closes);
  const macd = macdHistogram(closes);
  const bands = bollinger(closes);
  const volumeWeightedPrice = vwap(data);
  const volatility = atr(data);
  const avgVolume = data.slice(-21, -1).reduce((sum, c) => sum + c.volume, 0) / 20;
  const volumeRatio = avgVolume ? last.volume / avgVolume : 1;
  const momentum = last.close / closes.at(-4) - 1;
  const momentumThreshold = Math.max(0.0005, Math.min(0.004, (volatility / last.close) * 0.30));
  const recent = data.slice(-20);
  const support = Math.min(...recent.map((c) => c.low));
  const resistance = Math.max(...recent.map((c) => c.high));

  let score = 0;
  const add = (condition, weight) => { score += condition ? weight : -weight; };
  add(ema9 > ema21, 12);
  add(macd > 0, 12);
  if (strength > 55) score += 8;
  else if (strength < 45) score -= 8;
  score += last.close > bands.mid ? 5 : -5;
  add(last.close > volumeWeightedPrice, 10);

  if (volumeRatio > 1.2) {
    if (last.close > last.open) score += 8;
    else if (last.close < last.open) score -= 8;
  }
  if (momentum > momentumThreshold) score += 10;
  else if (momentum < -momentumThreshold) score -= 10;

  const range = Math.max(1, resistance - support);
  if ((last.close - support) / range < 0.15 && last.close > last.open) score += 8;
  if ((resistance - last.close) / range < 0.15 && last.close < last.open) score -= 8;

  let frameVotes = 0, frameCount = 0;
  let upConfirmations = 0, downConfirmations = 0;
  for (const key of ["1m", "5m", "1h"]) {
    if (otherFrames[key] === "UP") { frameVotes++; frameCount++; upConfirmations++; }
    if (otherFrames[key] === "DOWN") { frameVotes--; frameCount++; downConfirmations++; }
  }
  if (frameCount) score += 14 * frameVotes / frameCount;

  const direction = score >= 15 ? "UP" : score <= -15 ? "DOWN" : "WAIT";
  return {
    direction,
    score: Number(score.toFixed(2)),
    upConfirmations,
    downConfirmations,
    indicators: {
      emaTrend: ema9 > ema21 ? "Bullish" : "Bearish",
      rsi14: Number(strength.toFixed(2)),
      macd: macd >= 0 ? "Bullish" : "Bearish",
      vwap: last.close > volumeWeightedPrice ? "Above" : "Below",
      bollinger: last.close > bands.upper ? "Above upper" : last.close < bands.lower ? "Below lower" : "Inside",
      atr5m: Number(volatility.toFixed(2)),
      volumeRatio: Number(volumeRatio.toFixed(3)),
      support: Number(support.toFixed(2)),
      resistance: Number(resistance.toFixed(2)),
      momentumThreshold: Number(momentumThreshold.toFixed(6)),
      timeframe: otherFrames,
    },
  };
}

function parseTimestamp(value) {
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < 1e12) timestamp *= 1000;
  return timestamp;
}

function parseTwapMessage(raw, samples, feedMode, onError) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }

  if (feedMode === "polybolt") {
    if (message.op === "error") {
      onError("PolyBolt error: " + JSON.stringify(message));
      return;
    }
    if (message.channel !== "price.crypto.twap") return;
    const payload = message.payload || {};
    const rows = Array.isArray(payload.data) ? payload.data : [payload];
    for (const row of rows) {
      if (String(row.symbol || "btcusd").toLowerCase().replace("/", "") !== "btcusd") continue;
      const timestamp = parseTimestamp(row.timestamp || message.ts);
      let value = Number(row.value);
      if (!Number.isFinite(value) && row.full_accuracy_value != null) {
        value = Number(row.full_accuracy_value);
        if (value > 1e12) value /= 1e18;
      }
      if (Number.isFinite(timestamp) && Number.isFinite(value) && value > 0) {
        samples.push({ timestamp, value, source: row.source || payload.source || "chainlink" });
      }
    }
    return;
  }

  if (message.topic !== "crypto_prices_twap_sixty") return;
  const payload = message.payload || {};
  const rows = Array.isArray(payload.data) ? payload.data : [payload];
  for (const row of rows) {
    if (String(row.symbol || "btc/usd").toLowerCase().replace("/", "") !== "btcusd") continue;
    const timestamp = parseTimestamp(row.timestamp || row.ts || message.timestamp);
    let value = Number(row.value);
    if (!Number.isFinite(value) && row.full_accuracy_value != null) {
      value = Number(row.full_accuracy_value) / 1e18;
    }
    if (Number.isFinite(timestamp) && Number.isFinite(value) && value > 0) {
      samples.push({ timestamp, value, source: "chainlink" });
    }
  }
}

function startTwapCapture(stopAt, serverNow) {
  const samples = [];
  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_PASSPHRASE;
  const feedMode = apiKey && secret && passphrase ? "polybolt" : "legacy-rtds";
  let lastError = "";
  let socket = null;
  let heartbeat = null;

  const done = (async () => {
    try {
      if (typeof WebSocket === "undefined") throw new Error("Node.js WebSocket is unavailable.");
      const url = feedMode === "polybolt"
        ? "wss://ws-live-v2.polymarket.com/ws"
        : "wss://ws-live-data.polymarket.com";
      socket = new WebSocket(url);

      const opened = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("TWAP WebSocket open timeout.")), 12000);
        socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("TWAP WebSocket connection error.")); }, { once: true });
      });

      socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (feedMode === "polybolt" && message.op === "authed") {
          socket.send(JSON.stringify({
            op: "subscribe",
            rid: "btc-twap",
            subscriptions: [{
              channel: "price.crypto.twap",
              filter: { symbol: "btcusd", window_seconds: 60 },
            }],
          }));
          return;
        }
        parseTwapMessage(event.data, samples, feedMode, (error) => { lastError = error; });
      });

      await opened;
      if (feedMode === "polybolt") {
        socket.send(JSON.stringify({
          op: "auth",
          rid: "btc-auth",
          auth: { apiKey, secret, passphrase },
        }));
      } else {
        socket.send(JSON.stringify({
          action: "subscribe",
          subscriptions: [{
            topic: "crypto_prices_twap_sixty",
            type: "*",
            filters: '{"symbol":"btc/usd"}',
          }],
        }));
        heartbeat = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send("PING");
        }, 5000);
      }

      while (serverNow() < stopAt) await sleep(250);
    } catch (error) {
      lastError = error.message;
      console.log("TWAP feed error: " + lastError);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try { socket && socket.close(); } catch {}
    }

    samples.sort((a, b) => a.timestamp - b.timestamp);
    return { samples, feedMode, lastError };
  })();

  return { samples, feedMode, done };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

async function getResolvedOutcome(slug) {
  try {
    const events = await fetchJson("https://gamma-api.polymarket.com/events?slug=" + encodeURIComponent(slug));
    const event = Array.isArray(events) ? events[0] : null;
    const market = event && event.markets && event.markets[0];
    if (!market) return null;
    const outcomes = parseArray(market.outcomes).map((x) => String(x));
    const prices = parseArray(market.outcomePrices).map(Number);
    if (!outcomes.length || prices.length !== outcomes.length) return null;
    const winnerIndex = prices.findIndex((price) => price >= 0.999);
    const loserIndex = prices.findIndex((price) => price <= 0.001);
    if (winnerIndex < 0 || loserIndex < 0 || winnerIndex === loserIndex) return null;
    const winner = outcomes[winnerIndex].toUpperCase();
    return winner === "UP" || winner === "DOWN" ? winner : null;
  } catch (error) {
    console.log("Outcome not ready for " + slug + ": " + error.message);
    return null;
  }
}

function pickOpening(samples, roundStart) {
  return samples
    .filter((sample) => Math.abs(sample.timestamp - roundStart) <= OPEN_TOLERANCE_MS)
    .sort((a, b) => Math.abs(a.timestamp - roundStart) - Math.abs(b.timestamp - roundStart))[0] || null;
}

function chooseSignal(probability, model) {
  if (!probability || !probability.valid) {
    return { action: "NO TRADE", reason: probability ? probability.reason : "Probability model is unavailable." };
  }

  const side = probability.direction;
  const alignedConfirmations = model
    ? (side === "UP" ? model.upConfirmations : model.downConfirmations)
    : 0;
  const signedScore = model ? model.score * (side === "UP" ? 1 : -1) : 0;

  if (probability.confidence < probabilityEngine.MIN_CONFIDENCE) {
    return { action: "NO TRADE", reason: "Estimated advantage is below the experimental 64% threshold." };
  }
  if (model && model.direction !== "WAIT" && model.direction !== side && Math.abs(model.score) >= 18) {
    return { action: "NO TRADE", reason: "Technical indicators strongly conflict with the probability model." };
  }
  if (alignedConfirmations < 1 && signedScore < 12) {
    return { action: "NO TRADE", reason: "Technical indicators do not provide even one supporting confirmation." };
  }

  return {
    action: side === "UP" ? "BUY UP" : "BUY DOWN",
    reason: "Experimental probability estimate clears 64% and technical indicators provide supporting evidence. Paper signal only.",
  };
}

async function loadData() {
  try {
    const text = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.rounds) ? parsed : { version: 1, rounds: [] };
  } catch {
    return { version: 1, rounds: [] };
  }
}

async function main() {
  const offset = await getServerOffset();
  const serverNow = () => Date.now() + offset;
  const initialNow = serverNow();
  const currentBoundary = Math.floor(initialNow / ROUND_MS) * ROUND_MS;
  const roundStart = currentBoundary + ROUND_MS;
  const untilBoundary = roundStart - initialNow;

  if (untilBoundary > 6 * 60 * 1000) {
    console.log("Scheduled run is too early for the next round; skipping safely.");
    return;
  }
  if (untilBoundary < 0) throw new Error("Could not determine the next round boundary.");

  const data = await loadData();
  data.rounds ??= [];

  const alreadyRecorded = data.rounds.find((round) =>
    round.roundStart === roundStart && round.modelVersion === MODEL_VERSION
  );
  if (alreadyRecorded) {
    console.log("V4 checkpoints already recorded for " + new Date(roundStart).toISOString());
    return;
  }

  // Start before the opening boundary so the exact opening TWAP can be captured.
  const feed = startTwapCapture(roundStart + STOP_OFFSET_MS, serverNow);
  const samples = feed.samples;
  console.log("Started " + feed.feedMode + " TWAP capture for " + new Date(roundStart).toISOString());

  const checkpoints = [];
  let opening = null;

  for (const checkpoint of CHECKPOINTS) {
    const targetAt = roundStart + checkpoint.offsetMs;
    while (serverNow() < targetAt + 1800) await sleep(200);
    const decisionAt = serverNow();

    // Read only bars that were fully complete at the decision timestamp.
    const raw = await Promise.all(GRANULARITIES.map(getCandles));
    const bars1m = completedAsOf(raw[0], 60, decisionAt);
    const bars5m = completedAsOf(raw[1], 300, decisionAt);
    const bars1h = completedAsOf(raw[2], 3600, decisionAt);

    const tf = {
      "1m": timeframeDirection(bars1m),
      "5m": timeframeDirection(bars5m),
      "1h": timeframeDirection(bars1h),
    };
    const model = analyze(bars5m, tf);

    if (!opening) opening = pickOpening(samples, roundStart);
    const current = samples
      .filter((sample) => sample.timestamp <= decisionAt && sample.timestamp >= decisionAt - 30000)
      .sort((a, b) => b.timestamp - a.timestamp)[0] || null;

    const probability = probabilityEngine.estimate({
      opening,
      current,
      samples,
      minuteCandles: bars1m,
      decisionAt,
      roundEnd: roundStart + ROUND_MS,
    });
    const choice = chooseSignal(probability, model);
    const side = choice.action === "BUY UP" ? "UP" : choice.action === "BUY DOWN" ? "DOWN" : "WAIT";

    const record = {
      key: checkpoint.key,
      label: checkpoint.label,
      minuteMark: checkpoint.offsetMs / 60000,
      decisionAt,
      predictedAt: new Date(decisionAt).toISOString(),
      signalAction: choice.action,
      predictedDirection: side,
      signalReason: choice.reason,
      modelDirection: model ? model.direction : "WAIT",
      modelScore: model ? model.score : null,
      timeframeConfirmations: model
        ? (probability && probability.valid ? (probability.direction === "UP" ? model.upConfirmations : model.downConfirmations) : 0)
        : 0,
      probabilityUp: probability && probability.valid ? probability.probabilityUp : null,
      probabilityDown: probability && probability.valid ? probability.probabilityDown : null,
      estimatedWinChance: probability && probability.valid ? probability.confidence : null,
      probabilityDirection: probability && probability.valid ? probability.direction : "WAIT",
      probabilityValid: Boolean(probability && probability.valid),
      probabilityReason: probability && !probability.valid ? probability.reason : null,
      distanceBps: probability && probability.valid ? probability.distanceBps : null,
      sigmaBpsPerMinute: probability && probability.valid ? probability.sigmaBpsPerMinute : null,
      observedDriftBpsPerMinute: probability && probability.valid ? probability.observedDriftBpsPerMinute : null,
      usedDriftBpsPerMinute: probability && probability.valid ? probability.usedDriftBpsPerMinute : null,
      expectedFinalGapBps: probability && probability.valid ? probability.expectedFinalGapBps : null,
      forecastSigmaBps: probability && probability.valid ? probability.forecastSigmaBps : null,
      zScore: probability && probability.valid ? probability.zScore : null,
      remainingMinutes: probability && probability.valid ? probability.remainingMinutes : null,
      twapAgeMs: probability && probability.valid ? probability.twapAgeMs : null,
      driftSampleCount: probability && probability.valid ? probability.driftSampleCount : 0,
      openingTwap: opening ? opening.value : null,
      openingTwapTimestamp: opening ? opening.timestamp : null,
      currentTwap: current ? current.value : null,
      currentTwapTimestamp: current ? current.timestamp : null,
      technicalIndicators: model ? model.indicators : null,
      estimator: probability && probability.valid ? probability.estimator : "unavailable",
      calibrated: false,
      actualOutcome: null,
      result: null,
    };
    checkpoints.push(record);

    console.log(
      checkpoint.label + ": " + record.signalAction +
      " · P(UP)=" + (record.probabilityUp == null ? "n/a" : (record.probabilityUp * 100).toFixed(1) + "%") +
      " · price-to-beat=" + (record.distanceBps == null ? "n/a" : record.distanceBps + " bps") +
      " · reason=" + record.signalReason
    );
  }

  const completedFeed = await feed.done;
  opening = pickOpening(completedFeed.samples, roundStart) || opening;
  for (const checkpoint of checkpoints) {
    if (!checkpoint.openingTwap && opening) {
      checkpoint.openingTwap = opening.value;
      checkpoint.openingTwapTimestamp = opening.timestamp;
    }
  }

  const slug = "btc-updown-15m-" + Math.floor(roundStart / 1000);
  const record = {
    roundStart,
    roundEnd: roundStart + ROUND_MS,
    slug,
    modelVersion: MODEL_VERSION,
    estimator: "Student-t(df=5) with robust one-minute realized volatility and shrunk two-minute Chainlink TWAP drift",
    probabilityThreshold: probabilityEngine.MIN_CONFIDENCE,
    checkpointSchedule: CHECKPOINTS.map(c => c.label),
    captureMethod: "Pre-boundary Chainlink TWAP capture with six fixed-time, no-lookahead probability snapshots",
    feedMode: completedFeed.feedMode,
    feedError: completedFeed.lastError || null,
    updatedAt: new Date(serverNow()).toISOString(),
    openingTwap: opening ? opening.value : null,
    openingTwapTimestamp: opening ? opening.timestamp : null,
    checkpoints,
    actualOutcome: null,
    resolvedAt: null,
  };
  data.rounds.push(record);

  // Resolve older markets after collecting the complete current round.
  const pending = data.rounds
    .filter((round) => !round.actualOutcome && round.roundStart + ROUND_MS < serverNow() - 30000)
    .slice(-40);
  for (const round of pending) {
    const outcome = await getResolvedOutcome(round.slug);
    if (outcome) {
      round.actualOutcome = outcome;
      round.resolvedAt = new Date(serverNow()).toISOString();
      for (const checkpoint of round.checkpoints || []) {
        checkpoint.actualOutcome = outcome;
        checkpoint.result = checkpoint.predictedDirection === "WAIT"
          ? "NO_SIGNAL"
          : checkpoint.predictedDirection === outcome ? "WIN" : "LOSS";
      }
    }
  }

  data.rounds.sort((a, b) => a.roundStart - b.roundStart);
  data.rounds = data.rounds.slice(-600);
  data.version = 4;
  data.modelVersion = MODEL_VERSION;
  data.updatedAt = new Date(serverNow()).toISOString();
  data.schedule = "GitHub Actions begins before each 15-minute boundary and records six checkpoints at 3, 5, 8, 10, 12 and 13.5 minutes.";
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log("Saved " + checkpoints.length + " V4 checkpoint predictions for " + slug +
    " · opening TWAP " + (opening ? "captured" : "missing") +
    " · feed " + completedFeed.feedMode);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
