(function(root) {
  "use strict";

  const STUDENT_T_DF = 5;
  const MIN_CONFIDENCE = 0.64;

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function realizedSigmaBpsPerMinute(candles) {
    const rows = (candles || []).filter(c => Number.isFinite(c.close) && c.close > 0).slice(-31);
    if (rows.length < 9) return null;

    const returns = [];
    for (let i = 1; i < rows.length; i++) {
      returns.push(Math.log(rows[i].close / rows[i - 1].close) * 10000);
    }

    const center = median(returns);
    const mad = median(returns.map(value => Math.abs(value - center)));
    let sigma = mad * 1.4826;

    if (!Number.isFinite(sigma) || sigma < 0.05) {
      const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
      const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
      sigma = Math.sqrt(variance);
    }

    return Number.isFinite(sigma) && sigma > 0 ? Math.max(0.15, sigma) : null;
  }

  function logGamma(z) {
    const coefficients = [
      676.5203681218851,
      -1259.1392167224028,
      771.32342877765313,
      -176.61502916214059,
      12.507343278686905,
      -0.13857109526572012,
      9.9843695780195716e-6,
      1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (z + i + 1);
    const t = z + coefficients.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function betaContinuedFraction(a, b, x) {
    const maxIterations = 160;
    const epsilon = 3e-12;
    const minimum = 1e-30;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < minimum) d = minimum;
    d = 1 / d;
    let h = d;

    for (let m = 1; m <= maxIterations; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < minimum) d = minimum;
      c = 1 + aa / c;
      if (Math.abs(c) < minimum) c = minimum;
      d = 1 / d;
      h *= d * c;

      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < minimum) d = minimum;
      c = 1 + aa / c;
      if (Math.abs(c) < minimum) c = minimum;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < epsilon) break;
    }
    return h;
  }

  function regularizedBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(
      logGamma(a + b) - logGamma(a) - logGamma(b) +
      a * Math.log(x) + b * Math.log1p(-x)
    );
    if (x < (a + 1) / (a + b + 2)) {
      return front * betaContinuedFraction(a, b, x) / a;
    }
    return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
  }

  function studentTCdf(value, degreesOfFreedom) {
    if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
    const x = degreesOfFreedom / (degreesOfFreedom + value * value);
    const beta = regularizedBeta(x, degreesOfFreedom / 2, 0.5);
    const result = value >= 0 ? 1 - beta / 2 : beta / 2;
    return Math.max(0, Math.min(1, result));
  }

  function driftBpsPerMinute(samples, currentTimestamp, sigmaBpsPerMinute) {
    const rows = (samples || [])
      .filter(s => Number.isFinite(s.timestamp) && Number.isFinite(s.value) &&
        s.value > 0 && s.timestamp <= currentTimestamp && s.timestamp >= currentTimestamp - 120000)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (rows.length < 3 || rows[rows.length - 1].timestamp - rows[0].timestamp < 15000) {
      return { observed: 0, used: 0, count: rows.length, spanMs: rows.length > 1 ? rows[rows.length - 1].timestamp - rows[0].timestamp : 0 };
    }

    const origin = rows[0].timestamp;
    const xs = rows.map(s => (s.timestamp - origin) / 60000);
    const ys = rows.map(s => Math.log(s.value) * 10000);
    const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
    let numerator = 0, denominator = 0;
    for (let i = 0; i < xs.length; i++) {
      numerator += (xs[i] - meanX) * (ys[i] - meanY);
      denominator += (xs[i] - meanX) ** 2;
    }
    const observed = denominator > 0 ? numerator / denominator : 0;
    const limit = Math.max(0.05, sigmaBpsPerMinute * 0.20);
    const used = Math.max(-limit, Math.min(limit, observed * 0.25));
    return {
      observed: Number(observed.toFixed(4)),
      used: Number(used.toFixed(4)),
      count: rows.length,
      spanMs: rows[rows.length - 1].timestamp - rows[0].timestamp,
    };
  }

  function estimate(input) {
    const opening = input && input.opening;
    const current = input && input.current;
    const samples = input && input.samples;
    const candles = input && input.minuteCandles;
    const decisionAt = Number(input && input.decisionAt);
    const roundEnd = Number(input && input.roundEnd);

    if (!opening || !current || !Number.isFinite(opening.value) || !Number.isFinite(current.value) ||
        opening.value <= 0 || current.value <= 0 || !Number.isFinite(decisionAt) || !Number.isFinite(roundEnd)) {
      return { valid: false, reason: "Missing opening or current Chainlink TWAP." };
    }

    const ageMs = decisionAt - current.timestamp;
    if (!Number.isFinite(ageMs) || ageMs < -2000 || ageMs > 30000) {
      return { valid: false, reason: "Chainlink TWAP is stale." };
    }

    const sigma = realizedSigmaBpsPerMinute(candles);
    if (!Number.isFinite(sigma)) {
      return { valid: false, reason: "Not enough completed one-minute candles to estimate volatility." };
    }

    const remainingMinutes = Math.max(0, (roundEnd - decisionAt) / 60000);
    const distanceBps = Math.log(current.value / opening.value) * 10000;
    const drift = driftBpsPerMinute(samples, current.timestamp, sigma);
    const expectedFinalGapBps = distanceBps + drift.used * remainingMinutes;

    // The additional 0.35 minutes allows for the final 60-second settlement average.
    // A 15% volatility multiplier keeps the first version deliberately conservative.
    const forecastSigmaBps = Math.max(0.5, sigma * Math.sqrt(Math.max(0.35, remainingMinutes + 0.35)) * 1.15);
    const zScore = expectedFinalGapBps / forecastSigmaBps;
    const probabilityUp = Math.max(0.01, Math.min(0.99, studentTCdf(zScore, STUDENT_T_DF)));
    const probabilityDown = 1 - probabilityUp;

    return {
      valid: true,
      probabilityUp: Number(probabilityUp.toFixed(5)),
      probabilityDown: Number(probabilityDown.toFixed(5)),
      confidence: Number(Math.max(probabilityUp, probabilityDown).toFixed(5)),
      direction: probabilityUp >= 0.5 ? "UP" : "DOWN",
      distanceBps: Number(distanceBps.toFixed(3)),
      sigmaBpsPerMinute: Number(sigma.toFixed(4)),
      observedDriftBpsPerMinute: drift.observed,
      usedDriftBpsPerMinute: drift.used,
      remainingMinutes: Number(remainingMinutes.toFixed(3)),
      expectedFinalGapBps: Number(expectedFinalGapBps.toFixed(3)),
      forecastSigmaBps: Number(forecastSigmaBps.toFixed(3)),
      zScore: Number(zScore.toFixed(4)),
      twapAgeMs: Math.max(0, Math.round(ageMs)),
      driftSampleCount: drift.count,
      driftSampleSpanMs: drift.spanMs,
      degreesOfFreedom: STUDENT_T_DF,
      estimator: "Student-t(df=5), robust 1m realized volatility, shrunk 2m TWAP drift",
      calibrated: false,
    };
  }

  root.BTCProbabilityModel = {
    MIN_CONFIDENCE,
    STUDENT_T_DF,
    estimate,
    studentTCdf,
    realizedSigmaBpsPerMinute,
  };
})(typeof window !== "undefined" ? window : globalThis);
