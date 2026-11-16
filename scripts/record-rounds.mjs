import fs from "node:fs/promises";

const DATA_FILE = "data/rounds.json";
const ROUND_MS = 15 * 60 * 1000;
const GRANULARITIES = [60, 300, 900, 3600];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "BTC-AI-Lab-Accuracy-Recorder/1.0" },
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
  .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
  .sort((a, b) => a.time - b.time);
}

function completedAsOf(data, seconds, boundary) {
  return data.filter((c) => c.time + seconds * 1000 <= boundary);
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
  if (momentum > 0.001) score += 10;
  else if (momentum < -0.001) score -= 10;

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
  const qualifiedSide = score > 0 ? "UP" : "DOWN";
  const qualifiedVotes = qualifiedSide === "UP" ? upConfirmations : downConfirmations;
  const signalAction = Math.abs(score) >= 28 && qualifiedVotes >= 2
    ? (qualifiedSide === "UP" ? "BUY UP" : "BUY DOWN")
    : "NO TRADE";
  return {
    direction,
    signalAction,
    timeframeConfirmations: qualifiedVotes,
    score: Number(score.toFixed(2)),
    upScore: Number(up.toFixed(2)),
    downScore: Number(down.toFixed(2)),
    indicators: {
      emaTrend: ema9 > ema21 ? "Bullish" : "Bearish",
      rsi14: Number(strength.toFixed(2)),
      macd: macd >= 0 ? "Bullish" : "Bearish",
      vwap: last.close > volumeWeightedPrice ? "Above" : "Below",
      bollinger: last.close > bands.upper ? "Above upper" : last.close < bands.lower ? "Below lower" : "Inside",
      atr14: Number(volatility.toFixed(2)),
      volumeRatio: Number(volumeRatio.toFixed(3)),
      support: Number(support.toFixed(2)),
      resistance: Number(resistance.toFixed(2)),
      timeframe: otherFrames,
    },
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

function parseTwapMessage(raw, samples) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.topic !== "crypto_prices_twap_sixty") return;
  const payload = message.payload || {};
  const rows = Array.isArray(payload.data) ? payload.data : [payload];

  for (const row of rows) {
    if (String(row.symbol || "").toLowerCase() !== "btc/usd") continue;
    let timestamp = Number(row.timestamp || row.ts || 0);
    if (timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
    let value = Number(row.value);
    if (!Number.isFinite(value) && row.full_accuracy_value) {
      value = Number(row.full_accuracy_value) / 1e18;
    }
    if (Number.isFinite(timestamp) && Number.isFinite(value) && value > 0) {
      samples.push({ timestamp, value });
    }
  }
}

async function captureTwapAtBoundary(target, serverNow) {
  const samples = [];
  let socket;
  try {
    if (typeof WebSocket === "undefined") {
      console.log("Node WebSocket unavailable; final Polymarket outcomes will still be tracked.");
      return null;
    }
    socket = new WebSocket("wss://ws-live-data.polymarket.com");
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{
          topic: "crypto_prices_twap_sixty",
          type: "*",
          filters: '{"symbol":"btc/usd"}',
        }],
      }));
    });
    socket.addEventListener("message", (event) => parseTwapMessage(event.data, samples));
    socket.addEventListener("error", () => console.log("TWAP WebSocket error; final market outcome remains available."));
    while (serverNow() < target + 8000) await sleep(200);
  } catch (error) {
    console.log("TWAP capture unavailable: " + error.message);
  } finally {
    try { socket && socket.close(); } catch {}
  }

  return samples
    .filter((sample) => Math.abs(sample.timestamp - target) <= 5000)
    .sort((a, b) => Math.abs(a.timestamp - target) - Math.abs(b.timestamp - target))[0] || null;
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
  const target = Math.floor(initialNow / ROUND_MS) * ROUND_MS;
  const waitMs = target - initialNow;
  const data = await loadData();
  data.rounds ??= [];

  // Resolve markets recorded on previous runs.
  const unresolved = data.rounds
    .filter((round) => !round.actualOutcome && round.roundStart + ROUND_MS < initialNow - 30000)
    .slice(-20);
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

  // Runs are scheduled shortly after each market boundary.
  // Reconstruct the prediction from Coinbase candles completed by that boundary,
  // so a delayed GitHub runner does not use later price data or fabricate a signal.
  if (initialNow - target > 15 * 60 * 1000) {
    console.log("No valid recent boundary to record; previous results were checked.");
  } else {
    const boundaryTwapPromise = captureTwapAtBoundary(target, serverNow);

    const [raw1m, raw5m, raw15m, raw1h] = await Promise.all(GRANULARITIES.map(getCandles));
    const bars1m = completedAsOf(raw1m, 60, target);
    const bars5m = completedAsOf(raw5m, 300, target);
    const bars15m = completedAsOf(raw15m, 900, target);
    const bars1h = completedAsOf(raw1h, 3600, target);

    const tf = {
      "1m": timeframeDirection(bars1m),
      "5m": timeframeDirection(bars5m),
      "15m": timeframeDirection(bars15m),
      "1h": timeframeDirection(bars1h),
    };
    const prediction = analyze(bars15m, {
      "1m": tf["1m"], "5m": tf["5m"], "1h": tf["1h"],
    });
    if (!prediction) {
      throw new Error("Not enough completed candles at " + new Date(target).toISOString());
    }

    const boundaryTwap = await boundaryTwapPromise;
    const roundStart = target;
    const roundEnd = target + ROUND_MS;
    const slug = "btc-updown-15m-" + Math.floor(roundStart / 1000);
    let record = data.rounds.find((round) => round.roundStart === roundStart);

    if (!record) {
      record = {
        roundStart,
        roundEnd,
        slug,
        predictedAt: new Date(roundStart).toISOString(),
        collectedAt: new Date(serverNow()).toISOString(),
        captureDelaySeconds: Math.max(0, Math.round((serverNow() - roundStart) / 1000)),
        captureMethod: "delayed cloud snapshot reconstructed using candles completed by round start",
        predictedDirection: prediction.signalAction === "BUY UP" ? "UP" : prediction.signalAction === "BUY DOWN" ? "DOWN" : "WAIT",
        modelDirection: prediction.direction,
        signalAction: prediction.signalAction,
        timeframeConfirmations: prediction.timeframeConfirmations,
        upScore: prediction.upScore,
        downScore: prediction.downScore,
        modelScore: prediction.score,
        indicators: prediction.indicators,
        openingTwap: boundaryTwap ? boundaryTwap.value : null,
        openingTwapTimestamp: boundaryTwap ? boundaryTwap.timestamp : null,
        closingTwap: null,
        closingTwapTimestamp: null,
        actualOutcome: null,
        result: null,
      };
      data.rounds.push(record);
      console.log("Recorded " + prediction.direction + " for " + slug +
        "; boundary TWAP " + (boundaryTwap ? "captured" : "not captured"));
    } else {
      console.log("Prediction already exists for " + slug + "; leaving it unchanged.");
    }

    const previous = data.rounds.find((round) => round.roundStart === roundStart - ROUND_MS);
    if (previous && boundaryTwap) {
      previous.closingTwap = boundaryTwap.value;
      previous.closingTwapTimestamp = boundaryTwap.timestamp;
    }
  }

  // Re-check recent unresolved markets.
  const pending = data.rounds
    .filter((round) => !round.actualOutcome && round.roundStart + ROUND_MS < serverNow() - 30000)
    .slice(-8);
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
  data.rounds = data.rounds.slice(-300);
  data.updatedAt = new Date(serverNow()).toISOString();
  data.schedule = "GitHub Actions scheduled before each 15-minute boundary";
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
