import fs from "node:fs/promises";

const DATA_FILE = "data/rounds.json";
const ROUND_MS = 15 * 60 * 1000;
const MODEL_VERSION = "v3-volatility-aware";
const DECISION_OFFSET_MS = 100_000;
const MIN_SCORE = 28;
const MAX_TWAP_AGE_MS = 180_000;
const GRANULARITIES = [60, 300, 900, 3600];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "BTC-AI-Lab-Accuracy-Recorder/3.0" },
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
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close) && c.time <= Date.now() + 5000)
    .sort((a, b) => a.time - b.time);
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

  const up = Math.max(5, Math.min(95, 50 + score / 2));
  const down = 100 - up;
  const direction = score >= 15 ? "UP" : score <= -15 ? "DOWN" : "WAIT";
  return {
    direction,
    upScore: Number(up.toFixed(2)),
    downScore: Number(down.toFixed(2)),
    score: Number(score.toFixed(2)),
    upConfirmations,
    downConfirmations,
    timeframeConfirmations: direction === "UP" ? upConfirmations : direction === "DOWN" ? downConfirmations : 0,
    momentumThreshold: Number(momentumThreshold.toFixed(6)),
    indicators: {
      emaTrend: ema9 > ema21 ? "Bullish" : "Bearish",
      rsi14: Number(strength.toFixed(2)),
      macd: macd >= 0 ? "Bullish" : "Bearish",
      vwap: last.close > volumeWeightedPrice ? "Above" : "Below",
      bollinger: last.close > bands.upper ? "Above upper" : last.close < bands.lower ? "Below lower" : "Inside",
      atr15m: Number(volatility.toFixed(2)),
      volumeRatio: Number(volumeRatio.toFixed(3)),
      support: Number(support.toFixed(2)),
      resistance: Number(resistance.toFixed(2)),
      momentumThreshold: Number(momentumThreshold.toFixed(6)),
      timeframe: otherFrames,
    },
  };
}

function parseTwapMessage(raw, samples, feedMode) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }

  if (feedMode === "polybolt") {
    if (message.op === "error") {
      console.log("PolyBolt stream error: " + JSON.stringify(message));
      return;
    }
    if (message.channel !== "price.crypto.twap") return;
    const payload = message.payload || {};
    const rows = Array.isArray(payload.data) ? payload.data : [payload];
    for (const row of rows) {
      if (String(row.symbol || "btcusd").toLowerCase() !== "btcusd") continue;
      const timestamp = Number(row.timestamp || message.ts || 0);
      const value = Number(row.full_accuracy_value ?? row.value);
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
    if (String(row.symbol || "btc/usd").toLowerCase() !== "btc/usd") continue;
    let timestamp = Number(row.timestamp || row.ts || message.timestamp || 0);
    if (timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
    let value = Number(row.value);
    if (!Number.isFinite(value) && row.full_accuracy_value) {
      value = Number(row.full_accuracy_value) / 1e18;
    }
    if (Number.isFinite(timestamp) && Number.isFinite(value) && value > 0) {
      samples.push({ timestamp, value, source: "chainlink" });
    }
  }
}

async function collectTwapWindow(stopAt, serverNow) {
  const samples = [];
  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_PASSPHRASE;
  const feedMode = apiKey && secret && passphrase ? "polybolt" : "legacy-rtds";
  let socket;
  let heartbeat = null;

  try {
    if (typeof WebSocket === "undefined") {
      console.log("WebSocket unavailable; this round will be recorded as NO TRADE.");
      while (serverNow() < stopAt) await sleep(200);
      return { samples, feedMode: "unavailable" };
    }

    const url = feedMode === "polybolt"
      ? "wss://ws-live-v2.polymarket.com/ws"
      : "wss://ws-live-data.polymarket.com";
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
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
      parseTwapMessage(event.data, samples, feedMode);
    });

    socket.addEventListener("error", () => {
      console.log(feedMode + " TWAP WebSocket error.");
    });

    while (serverNow() < stopAt) await sleep(200);
  } catch (error) {
    console.log("TWAP collection failed: " + error.message);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try { socket && socket.close(); } catch {}
  }

  samples.sort((a, b) => a.timestamp - b.timestamp);
  return { samples, feedMode };
}

function requiredPriceBeatBps(reference, oneMinuteAtr) {
  if (!reference || reference <= 0) return 2;
  const volatilityBps = oneMinuteAtr > 0 ? (oneMinuteAtr / reference) * 10000 : 0;
  return Math.max(2, Math.min(8, volatilityBps * 0.20));
}

function evaluateSignal({ model, opening, current, samples, oneMinuteAtr, roundStart, decisionAt }) {
  const elapsed = decisionAt - roundStart;
  const remaining = roundStart + ROUND_MS - decisionAt;
  const confirmations = model
    ? (model.direction === "UP" ? model.upConfirmations : model.direction === "DOWN" ? model.downConfirmations : 0)
    : 0;
  const distanceBps = opening && current ? (current.value / opening.value - 1) * 10000 : null;
  const requiredBps = opening ? requiredPriceBeatBps(opening.value, oneMinuteAtr) : 2;
  const recent = current
    ? samples.filter((sample) => sample.timestamp >= current.timestamp - 20000 && sample.timestamp <= current.timestamp)
    : [];
  const recentSpan = recent.length > 1 ? recent.at(-1).timestamp - recent[0].timestamp : 0;
  const momentumBps = opening && recent.length > 1
    ? (recent.at(-1).value / recent[0].value - 1) * 10000
    : null;
  const twapAge = current ? decisionAt - current.timestamp : Infinity;

  let reason = "";
  let action = "NO TRADE";
  if (!model) reason = "Not enough candle history to calculate the model.";
  else if (!opening) reason = "Opening Chainlink TWAP was not captured at the market boundary.";
  else if (!current || twapAge > MAX_TWAP_AGE_MS) reason = "Chainlink TWAP is missing or stale.";
  else if (elapsed < 60000) reason = "The first minute of the market has not elapsed.";
  else if (remaining <= 60000) reason = "Too close to market settlement.";
  else if (model.direction === "WAIT" || Math.abs(model.score) < MIN_SCORE) reason = "Technical score is below the BUY threshold.";
  else if (confirmations < 2) reason = "Fewer than two of the 1m, 5m and 1h trends confirm the model.";
  else if (Math.abs(distanceBps) < requiredBps) reason = "Chainlink has not cleared the volatility-adjusted price-to-beat threshold.";
  else if (recent.length < 2 || recentSpan < 8000 || momentumBps === null) reason = "Not enough recent TWAP samples to confirm the move is continuing.";
  else if (Math.sign(momentumBps) !== Math.sign(distanceBps)) reason = "The latest TWAP movement is fading or reversing against the price-to-beat move.";
  else if ((distanceBps > 0 ? "UP" : "DOWN") !== model.direction) reason = "Chainlink price-to-beat conflicts with the technical model.";
  else {
    action = model.direction === "UP" ? "BUY UP" : "BUY DOWN";
    reason = "Technical score, timeframes and a volatility-adjusted Chainlink move agree. Paper signal only.";
  }

  return {
    signalAction: action,
    reason,
    confirmations,
    distanceBps: distanceBps === null ? null : Number(distanceBps.toFixed(3)),
    requiredBps: Number(requiredBps.toFixed(3)),
    momentumBps: momentumBps === null ? null : Number(momentumBps.toFixed(3)),
    twapAgeMs: Number.isFinite(twapAge) ? Math.max(0, Math.round(twapAge)) : null,
    twapSamplesInMomentumWindow: recent.length,
    twapMomentumWindowMs: recentSpan,
  };
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
  const target = currentBoundary + ROUND_MS;
  const untilBoundary = target - initialNow;
  if (untilBoundary > 6 * 60 * 1000) {
    console.log("Scheduled run started too early for the next market window; skipping safely.");
    return;
  }
  if (untilBoundary < 0) throw new Error("Could not determine the next market boundary.");

  const data = await loadData();
  data.rounds ??= [];

  const alreadyRecorded = data.rounds.find((round) =>
    round.roundStart === target && round.modelVersion === MODEL_VERSION
  );
  // Open the reference-price stream before any slower settlement lookups so the
  // exact market-opening TWAP has the best chance of being captured.
  const twapPromise = alreadyRecorded
    ? Promise.resolve({ samples: [], feedMode: "already-recorded" })
    : collectTwapWindow(target + DECISION_OFFSET_MS, serverNow);

  const unresolved = data.rounds
    .filter((round) => !round.actualOutcome && round.roundStart + ROUND_MS < initialNow - 30000)
    .slice(-30);
  for (const round of unresolved) {
    const outcome = await getResolvedOutcome(round.slug);
    if (outcome) {
      round.actualOutcome = outcome;
      round.result = round.predictedDirection === "WAIT"
        ? "NO_SIGNAL"
        : round.predictedDirection === outcome ? "WIN" : "LOSS";
      round.resolvedAt = new Date(serverNow()).toISOString();
    }
  }

  if (!alreadyRecorded) {
    console.log("Collecting the Chainlink TWAP feed for " + new Date(target).toISOString());
    while (serverNow() < target + DECISION_OFFSET_MS) await sleep(200);

    const [raw1m, raw5m, raw15m, raw1h] = await Promise.all(GRANULARITIES.map(getCandles));
    const decisionAt = serverNow();
    const roundStart = target;
    const inRound = (rows) => rows.filter((c) => c.time <= decisionAt);
    const bars1m = inRound(raw1m);
    const bars5m = inRound(raw5m);
    const bars15m = inRound(raw15m);
    const bars1h = inRound(raw1h);
    const tf = {
      "1m": timeframeDirection(bars1m),
      "5m": timeframeDirection(bars5m),
      "15m": timeframeDirection(bars15m),
      "1h": timeframeDirection(bars1h),
    };
    const model = analyze(bars15m, {
      "1m": tf["1m"], "5m": tf["5m"], "1h": tf["1h"],
    });
    const { samples, feedMode } = await twapPromise;

    const opening = samples
      .filter((sample) => Math.abs(sample.timestamp - roundStart) <= 5000)
      .sort((a, b) => Math.abs(a.timestamp - roundStart) - Math.abs(b.timestamp - roundStart))[0] || null;
    const current = samples
      .filter((sample) => sample.timestamp <= decisionAt && sample.timestamp >= decisionAt - MAX_TWAP_AGE_MS)
      .sort((a, b) => b.timestamp - a.timestamp)[0] || null;
    const oneMinuteAtr = atr(bars1m.slice(-30));
    const decision = evaluateSignal({
      model, opening, current, samples, oneMinuteAtr, roundStart, decisionAt,
    });
    const slug = "btc-updown-15m-" + Math.floor(roundStart / 1000);
    const record = {
      roundStart,
      roundEnd: roundStart + ROUND_MS,
      slug,
      modelVersion: MODEL_VERSION,
      predictedAt: new Date(decisionAt).toISOString(),
      signalOffsetSeconds: Number(((decisionAt - roundStart) / 1000).toFixed(1)),
      collectedAt: new Date(serverNow()).toISOString(),
      captureDelaySeconds: Math.max(0, Math.round((serverNow() - roundStart) / 1000)),
      captureMethod: "pre-boundary TWAP capture and fixed live-rule snapshot",
      feedMode,
      predictedDirection: decision.signalAction === "BUY UP" ? "UP" : decision.signalAction === "BUY DOWN" ? "DOWN" : "WAIT",
      modelDirection: model ? model.direction : "WAIT",
      signalAction: decision.signalAction,
      signalReason: decision.reason,
      timeframeConfirmations: decision.confirmations,
      upScore: model ? model.upScore : null,
      downScore: model ? model.downScore : null,
      modelScore: model ? model.score : null,
      momentumThreshold: model ? model.momentumThreshold : null,
      oneMinuteAtr: Number(oneMinuteAtr.toFixed(2)),
      openingTwap: opening ? opening.value : null,
      openingTwapTimestamp: opening ? opening.timestamp : null,
      signalTwap: current ? current.value : null,
      signalTwapTimestamp: current ? current.timestamp : null,
      twapDistanceBps: decision.distanceBps,
      requiredPriceBeatBps: decision.requiredBps,
      twapMomentumBps: decision.momentumBps,
      twapAgeMs: decision.twapAgeMs,
      twapSamplesInMomentumWindow: decision.twapSamplesInMomentumWindow,
      twapMomentumWindowMs: decision.twapMomentumWindowMs,
      indicators: model ? model.indicators : null,
      actualOutcome: null,
      result: null,
    };
    data.rounds.push(record);
    console.log(
      record.signalAction + " for " + slug +
      " · reason: " + record.signalReason +
      " · opening TWAP: " + (opening ? "captured" : "missing") +
      " · feed: " + feedMode
    );
  } else {
    console.log("A " + MODEL_VERSION + " snapshot already exists for this round.");
  }

  const pending = data.rounds
    .filter((round) => !round.actualOutcome && round.roundStart + ROUND_MS < serverNow() - 30000)
    .slice(-30);
  for (const round of pending) {
    const outcome = await getResolvedOutcome(round.slug);
    if (outcome) {
      round.actualOutcome = outcome;
      round.result = round.predictedDirection === "WAIT"
        ? "NO_SIGNAL"
        : round.predictedDirection === outcome ? "WIN" : "LOSS";
      round.resolvedAt = new Date(serverNow()).toISOString();
    }
  }

  data.rounds.sort((a, b) => a.roundStart - b.roundStart);
  data.rounds = data.rounds.slice(-600);
  data.version = 2;
  data.modelVersion = MODEL_VERSION;
  data.updatedAt = new Date(serverNow()).toISOString();
  data.schedule = "GitHub Actions starts before each 15-minute boundary and records one live-rule snapshot about 100 seconds into the round.";
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
