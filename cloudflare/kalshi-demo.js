const BASE = "https://external-api.demo.kalshi.co/trade-api/v2";
const API_ROOT = "/trade-api/v2";

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Vary": "Origin",
    },
  });
}

function pemBytes(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function concatBytes(...parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
function derLength(n) {
  if (n < 128) return Uint8Array.of(n);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 255); n >>>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
function der(tag, content) {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}
function pkcs1ToPkcs8(pkcs1) {
  const version = Uint8Array.of(0x02,0x01,0x00);
  const algorithm = Uint8Array.of(0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00);
  return der(0x30, concatBytes(version, algorithm, der(0x04, pkcs1)));
}
async function loadSigningKey(pem) {
  const bytes = pemBytes(pem);
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  if (isPkcs1) {
    return { key: await crypto.subtle.importKey("pkcs8", pkcs1ToPkcs8(bytes), {name:"RSA-PSS",hash:"SHA-256"}, false, ["sign"]), algorithm:"RSA-PSS" };
  }
  try {
    return { key: await crypto.subtle.importKey("pkcs8", bytes, {name:"Ed25519"}, false, ["sign"]), algorithm:"Ed25519" };
  } catch {
    return { key: await crypto.subtle.importKey("pkcs8", bytes, {name:"RSA-PSS",hash:"SHA-256"}, false, ["sign"]), algorithm:"RSA-PSS" };
  }
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function signedKalshiRequest(env, method, endpoint, body) {
  if (!env.KALSHI_DEMO_API_KEY_ID || !env.KALSHI_DEMO_PRIVATE_KEY) {
    throw new Error("Kalshi DEMO API credentials are not configured in Cloudflare Worker secrets.");
  }
  const path = API_ROOT + endpoint.split("?")[0];
  const timestamp = String(Date.now());
  const message = new TextEncoder().encode(timestamp + method.toUpperCase() + path);
  const signing = await loadSigningKey(env.KALSHI_DEMO_PRIVATE_KEY);
  const signature = signing.algorithm === "Ed25519"
    ? await crypto.subtle.sign({name:"Ed25519"}, signing.key, message)
    : await crypto.subtle.sign({name:"RSA-PSS",saltLength:32}, signing.key, message);
  const headers = {
    "KALSHI-ACCESS-KEY": env.KALSHI_DEMO_API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": toBase64(new Uint8Array(signature)),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(BASE + endpoint, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {message: raw.slice(0, 500)}; }
  if (!response.ok) {
    const messageText = data.details || data.message || data.code || ("Kalshi returned HTTP " + response.status);
    throw new Error("Kalshi DEMO API " + response.status + ": " + messageText);
  }
  return data;
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}
function dollarsFromBalance(balance) {
  if (balance && balance.balance_dollars != null) return Number(balance.balance_dollars);
  if (balance && balance.balance != null) return Number(balance.balance) / 100;
  throw new Error("Kalshi balance response did not contain a recognized balance field.");
}
function dollarsFromPortfolioValue(balance) {
  if (balance && balance.portfolio_value_dollars != null) return Number(balance.portfolio_value_dollars);
  if (balance && balance.portfolio_value != null) return Number(balance.portfolio_value) / 100;
  throw new Error("Kalshi portfolio value is missing; refusing to estimate account equity.");
}
async function getTodayFillAudit(env) {
  // Pull every fill since UTC midnight. This is an audit trail, not a homemade
  // realized-P&L calculation; equity drawdown remains the authoritative loss stop.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const minTs = Math.floor(start.getTime() / 1000);
  let cursor = "";
  const fills = [];
  const seenCursors = new Set();
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({limit:"200", min_ts:String(minTs)});
    if (cursor) params.set("cursor", cursor);
    const data = await signedKalshiRequest(env, "GET", "/portfolio/fills?" + params.toString());
    if (!Array.isArray(data.fills)) throw new Error("Kalshi fills response was missing its fills list.");
    fills.push(...data.fills);
    const next = String(data.cursor || "");
    if (!next) {
      const fees = fills.reduce((sum, f) => sum + Number(f.fee_cost || 0), 0);
      if (!Number.isFinite(fees)) throw new Error("Fill fee data was invalid.");
      const ids = fills.map(f => f.fill_id || f.trade_id).filter(Boolean);
      if (ids.length !== fills.length) throw new Error("One or more fills lacked a unique fill ID; refusing to trust the fill audit.");
      return {
        complete: true,
        utcDayStart: start.toISOString(),
        fillCount: fills.length,
        feeCostDollars: Number(fees.toFixed(4)),
        lastFillTime: fills.reduce((latest, f) => !latest || String(f.created_time || "") > latest ? String(f.created_time || "") : latest, ""),
        uniqueFillCount: new Set(ids).size
      };
    }
    if (seenCursors.has(next)) throw new Error("Kalshi fills pagination repeated a cursor; fill audit incomplete.");
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("More than 10 pages of today's fills; refusing to treat an incomplete fill audit as safe.");
}

async function getRiskSnapshot(env) {
  if (!env.BOT_STATE) throw new Error("The BOT_STATE KV binding is missing. Add it in Worker Settings > Bindings.");
  const [balance, positions, orders, fillAudit] = await Promise.all([
    signedKalshiRequest(env, "GET", "/portfolio/balance"),
    signedKalshiRequest(env, "GET", "/portfolio/positions?limit=1000"),
    signedKalshiRequest(env, "GET", "/portfolio/orders?limit=200"),
    getTodayFillAudit(env),
  ]);
  const cash = dollarsFromBalance(balance);
  const portfolioValue = dollarsFromPortfolioValue(balance);
  const equity = cash + portfolioValue;
  if (![cash, portfolioValue, equity].every(Number.isFinite)) throw new Error("Could not safely calculate DEMO account equity.");
  const dayKey = utcDayKey();
  const key = "risk:daily:" + dayKey;
  let record = await env.BOT_STATE.get(key, "json");
  if (!record) {
    record = { day: dayKey, startingEquity: equity, createdAt: new Date().toISOString() };
    await env.BOT_STATE.put(key, JSON.stringify(record));
  } else if (!Number.isFinite(Number(record.startingEquity))) {
    record.startingEquity = Number(record.startingBalance);
    if (!Number.isFinite(record.startingEquity)) throw new Error("Saved daily risk baseline is invalid; automatic entries must remain disabled.");
    await env.BOT_STATE.put(key, JSON.stringify(record));
  }
  const drawdown = Math.max(0, Number(record.startingEquity) - equity);
  const positionRows = positions.market_positions || [];
  const openPositions = positionRows.filter(p => Math.abs(Number(p.position_fp ?? 0)) > 0);
  const orderRows = orders.orders || [];
  const restingOrders = orderRows.filter(o => ["resting","pending","open"].includes(String(o.status || "").toLowerCase()) && Number(o.remaining_count_fp ?? o.remaining_count ?? 0) > 0);
  return {
    environment: "DEMO",
    day: dayKey,
    startingEquity: Number(record.startingEquity),
    cashBalance: cash,
    portfolioValue,
    currentEquity: equity,
    balanceDrawdown: Number(drawdown.toFixed(2)),
    dailyLossLimit: 5,
    maxEntryCost: 1,
    maxOpenPositions: 1,
    openPositionCount: openPositions.length,
    restingOrderCount: restingOrders.length,
    dailyFillAudit: fillAudit,
    dailyLossMeasure: "account equity drawdown from the first risk snapshot recorded for this UTC day; includes realized and marked portfolio value changes",
    riskLimitReached: drawdown >= 5,
    fillAuditComplete: fillAudit.complete === true,
    entryAllowed: drawdown < 5 && openPositions.length === 0 && restingOrders.length === 0 && fillAudit.complete === true,
    tradingEnabled: false,
    note: "Daily loss stop uses account equity drawdown (cash plus portfolio value) from the first risk snapshot recorded each UTC day. Today's fills and fees are independently audited with complete pagination; fill audit failure blocks entries. This is not yet a verified fill-by-fill realized P&L ledger. Automatic order execution remains disabled.",
  };
}

// Convert a BTC directional intent into Kalshi's V2 YES-book side.
// Entry UP = buy YES (bid); entry DOWN = buy NO (ask).
// Exit UP = sell YES (ask); exit DOWN = sell NO (bid).
function mapBtcIntentToKalshiV2(intent, direction) {
  const normalizedIntent = String(intent || "").toLowerCase();
  const normalizedDirection = String(direction || "").toUpperCase();
  if (!["entry","exit"].includes(normalizedIntent) || !["UP","DOWN"].includes(normalizedDirection)) {
    throw new Error("Intent must be entry/exit and direction must be UP/DOWN.");
  }
  const map = {
    entry: { UP: "bid", DOWN: "ask" },
    exit:  { UP: "ask", DOWN: "bid" },
  };
  return {
    intent: normalizedIntent,
    direction: normalizedDirection,
    kalshiV2Side: map[normalizedIntent][normalizedDirection],
    exposure: normalizedIntent === "entry" ? normalizedDirection : "close " + normalizedDirection,
    note: "V2 side is expressed on the YES book: bid increases YES exposure; ask decreases YES exposure (increases NO exposure)."
  };
}
function verifyBtcIntentMapping() {
  const cases = [
    ["entry","UP","bid"],["entry","DOWN","ask"],
    ["exit","UP","ask"],["exit","DOWN","bid"]
  ];
  return cases.every(([intent,direction,expected]) =>
    mapBtcIntentToKalshiV2(intent,direction).kalshiV2Side === expected
  );
}

function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleKalshiRequest(request, env, url) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = env.ALLOWED_ORIGIN || "https://dustin465-coder.github.io";
  if (origin !== allowedOrigin) return json({error:"Origin not allowed"}, 403, allowedOrigin);
  if (request.method === "OPTIONS") return json({ok:true}, 200, allowedOrigin);

  const supplied = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.BOT_ACCESS_TOKEN || !sameToken(supplied, env.BOT_ACCESS_TOKEN)) {
    return json({error:"Dashboard access token is missing or incorrect."}, 401, allowedOrigin);
  }

  if (!env.KALSHI_DEMO_API_KEY_ID || !env.KALSHI_DEMO_PRIVATE_KEY) {
    return json({error:"Add KALSHI_DEMO_API_KEY_ID and KALSHI_DEMO_PRIVATE_KEY as Cloudflare Worker secrets."}, 503, allowedOrigin);
  }

  try {
    if (url.pathname === "/kalshi/supervised-order-check" && request.method === "GET") {
      // Read-only deployment probe. This route never submits an order.
      return json({
        environment:"DEMO",
        endpoint:"/kalshi/supervised-order",
        supervisedOrderRouteInstalled:true,
        explicitConfirmationRequired:true,
        maximumContractsPerOrder:1,
        fillOrKill:true,
        mappingTestsPassed:verifyBtcIntentMapping(),
        legacyOrderRouteLocked:true,
        orderSent:false,
        checkedAt:new Date().toISOString()
      }, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/order-preview" && request.method === "GET") {
      // Dry-run mapping endpoint. It never submits or changes an order.
      const intent = String(url.searchParams.get("intent") || "").toLowerCase();
      const direction = String(url.searchParams.get("direction") || "").toUpperCase();
      const mapping = mapBtcIntentToKalshiV2(intent, direction);
      return json({environment:"DEMO", readOnly:true, ...mapping, mappingTestsPassed:verifyBtcIntentMapping(), orderSent:false}, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/preflight" && request.method === "GET") {
      // Read-only readiness check. This route never creates, changes, or cancels orders.
      const ticker = String(url.searchParams.get("ticker") || "").trim();
      if (!/^[A-Z0-9_-]{3,80}$/.test(ticker)) throw new Error("Choose a valid BTC 15-minute market ticker.");
      const [marketResponse, positions, orders, fills, dailyFillAudit] = await Promise.all([
        fetch(BASE + "/markets/" + encodeURIComponent(ticker), {headers:{"Accept":"application/json"}}),
        signedKalshiRequest(env, "GET", "/portfolio/positions?limit=1000&count_filter=position&ticker=" + encodeURIComponent(ticker)),
        signedKalshiRequest(env, "GET", "/portfolio/orders?limit=200"),
        signedKalshiRequest(env, "GET", "/portfolio/fills?limit=200"),
        getTodayFillAudit(env),
      ]);
      const marketData = await marketResponse.json();
      if (!marketResponse.ok) throw new Error("Could not verify selected market: " + (marketData.message || marketResponse.status));
      const market = marketData.market || marketData;
      const status = String(market.status || "").toLowerCase();
      const closeMs = market.close_time ? Date.parse(market.close_time) : NaN;
      const active = ["open","active"].includes(status) && Number.isFinite(closeMs) && closeMs > Date.now();
      const quote = (dollars, cents) => {
        if (dollars !== null && dollars !== undefined && dollars !== "") {
          const n = Number(dollars);
          if (Number.isFinite(n) && n > 0 && n < 1) return n;
        }
        if (cents !== null && cents !== undefined && cents !== "") {
          const n = Number(cents) / 100;
          if (Number.isFinite(n) && n > 0 && n < 1) return n;
        }
        return null;
      };
      const yesAsk = quote(market.yes_ask_dollars, market.yes_ask);
      const noAsk = quote(market.no_ask_dollars, market.no_ask);
      const positionRows = positions.market_positions || [];
      const selectedPositions = positionRows.filter(p => p.ticker === ticker && Math.abs(Number(p.position_fp ?? 0)) > 0);
      const orderRows = orders.orders || [];
      const restingOrders = orderRows.filter(o =>
        o.ticker === ticker &&
        ["resting","pending","open"].includes(String(o.status || "").toLowerCase()) &&
        Number(o.remaining_count_fp ?? o.remaining_count ?? 0) > 0
      );
      const fillRows = fills.fills || [];
      const checks = {
        demoEnvironment: true,
        marketActive: active,
        bothAsksAvailable: yesAsk !== null && noAsk !== null,
        noExistingPositionInSelectedMarket: selectedPositions.length === 0,
        noRestingOrderInSelectedMarket: restingOrders.length === 0,
        fillsEndpointReadable: Array.isArray(fillRows),
        dailyFillAuditComplete: dailyFillAudit.complete === true,
        entryMappingValidated: verifyBtcIntentMapping(),
        exitMappingValidated: verifyBtcIntentMapping(),
        fillBasedLossControlValidated: false,
        orderSubmissionEnabled: false
      };
      const passed = Object.values(checks).filter(Boolean).length;
      return json({
        environment:"DEMO",
        readOnly:true,
        ticker,
        marketStatus:market.status || "unknown",
        closeTime:market.close_time || null,
        yesAskDollars:yesAsk,
        noAskDollars:noAsk,
        selectedPositionCount:selectedPositions.length,
        selectedPositions,
        selectedRestingOrderCount:restingOrders.length,
        recentFillCount:fillRows.length,
        dailyFillAudit,
        checks,
        passedChecks:passed,
        totalChecks:Object.keys(checks).length,
        readyToSubmit:false,
        note:"Read-only preflight only. Four directional mappings are checked in code: entry UP=bid, entry DOWN=ask, exit UP=ask, exit DOWN=bid. This verifies translation logic, not an actual filled entry/exit. Today's fill audit must paginate completely. Daily loss control still uses account-equity drawdown rather than a verified realized-P&L ledger. No order was sent."
      }, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/risk-status" && request.method === "GET") {
      const risk = await getRiskSnapshot(env);
      return json(risk, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/status" && request.method === "GET") {
      const [balance, exchange] = await Promise.all([
        signedKalshiRequest(env, "GET", "/portfolio/balance"),
        signedKalshiRequest(env, "GET", "/exchange/status"),
      ]);
      return json({
        connected:true,
        environment:"DEMO",
        balance,
        exchange,
        keyType:"configured",
        message:"Authenticated against Kalshi's DEMO environment only.",
      }, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/markets" && request.method === "GET") {
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 1000)));
      const status = url.searchParams.get("status") === "closed" ? "closed" : "open";
      const query = new URLSearchParams({status, limit:String(limit), series_ticker:"KXBTC15M"});
      const response = await fetch(BASE + "/markets?" + query.toString(), {headers:{"Accept":"application/json"}});
      const data = await response.json();
      if (!response.ok) throw new Error("Kalshi market lookup failed: " + (data.message || response.status));
      const markets = (data.markets || []).filter(m => /bitcoin|\bbtc\b/i.test((m.title || "") + " " + (m.ticker || "")));
      return json({environment:"DEMO", markets, cursor:data.cursor || null}, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/market" && request.method === "GET") {
      const ticker = String(url.searchParams.get("ticker") || "").trim();
      if (!/^[A-Z0-9_-]{3,80}$/.test(ticker)) throw new Error("Choose a valid market ticker.");
      const response = await fetch(BASE + "/markets/" + encodeURIComponent(ticker), {headers:{"Accept":"application/json"}});
      const data = await response.json();
      if (!response.ok) throw new Error("Kalshi market quote failed: " + (data.message || response.status));
      return json({environment:"DEMO", market:data.market || data}, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/positions" && request.method === "GET") {
      const data = await signedKalshiRequest(env, "GET", "/portfolio/positions?limit=100");
      return json({environment:"DEMO", ...data}, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/orders" && request.method === "GET") {
      const data = await signedKalshiRequest(env, "GET", "/portfolio/orders?limit=100");
      return json({environment:"DEMO", ...data}, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/fills" && request.method === "GET") {
      const data = await signedKalshiRequest(env, "GET", "/portfolio/fills?limit=100");
      return json({environment:"DEMO", ...data}, 200, allowedOrigin);
    }

    if (url.pathname === "/kalshi/supervised-order" && request.method === "POST") {
      // One-contract, explicitly confirmed DEMO-only test. FOK prevents resting remainder.
      const input = await request.json();
      const ticker = String(input.ticker || "").trim();
      const intent = String(input.intent || "").toLowerCase();
      const direction = String(input.direction || "").toUpperCase();
      const contractPrice = Number(input.contractPrice);
      if (input.confirmDemoOrder !== true) throw new Error("Explicit DEMO confirmation is required; no order sent.");
      if (!/^[A-Z0-9_-]{3,80}$/.test(ticker)) throw new Error("Choose a valid market ticker.");
      if (!["entry","exit"].includes(intent) || !["UP","DOWN"].includes(direction)) throw new Error("Choose entry/exit and UP/DOWN.");
      if (!Number.isFinite(contractPrice) || contractPrice < 0.01 || contractPrice > 0.99) throw new Error("Contract limit price must be $0.01-$0.99.");
      const marketResponse = await fetch(BASE + "/markets/" + encodeURIComponent(ticker), {headers:{"Accept":"application/json"}});
      const marketData = await marketResponse.json();
      if (!marketResponse.ok) throw new Error("Could not verify market; order blocked.");
      const market = marketData.market || marketData;
      const closeMs = market.close_time ? Date.parse(market.close_time) : NaN;
      if (!["open","active"].includes(String(market.status || "").toLowerCase()) || !Number.isFinite(closeMs) || closeMs <= Date.now()) {
        throw new Error("Market is not active and unexpired; order blocked.");
      }
      const side = mapBtcIntentToKalshiV2(intent, direction).kalshiV2Side;
      const yesPrice = direction === "UP" ? contractPrice : Number((1 - contractPrice).toFixed(4));
      if (intent === "entry") {
        const risk = await getRiskSnapshot(env);
        if (!risk.entryAllowed || !risk.fillAuditComplete || risk.riskLimitReached) throw new Error("Entry blocked by DEMO risk checks. Check equity drawdown, fills audit, positions and resting orders.");
        if (contractPrice > 1.00) throw new Error("Entry cost exceeds the $1.00 cap.");
      } else {
        const [positions, orders] = await Promise.all([
          signedKalshiRequest(env, "GET", "/portfolio/positions?limit=1000&count_filter=position&ticker=" + encodeURIComponent(ticker)),
          signedKalshiRequest(env, "GET", "/portfolio/orders?limit=200"),
        ]);
        const rows = positions.market_positions || [];
        const p = rows.find(x => x.ticker === ticker && Math.abs(Number(x.position_fp ?? 0)) >= 1);
        const held = p ? Number(p.position_fp) : 0;
        if (!p || (direction === "UP" && held <= 0) || (direction === "DOWN" && held >= 0)) {
          throw new Error("Exit blocked: no matching one-contract-or-larger " + direction + " position was verified.");
        }
        const resting = (orders.orders || []).some(o => o.ticker === ticker && ["resting","pending","open"].includes(String(o.status || "").toLowerCase()) && Number(o.remaining_count_fp ?? o.remaining_count ?? 0) > 0);
        if (resting) throw new Error("Exit blocked: a resting order already exists for this market. Cancel or resolve it first.");
      }
      const body = {
        ticker, side, count:"1", price:yesPrice.toFixed(4),
        time_in_force:"fill_or_kill",
        self_trade_prevention_type:"taker_at_cross",
        client_order_id:"btc-demo-test-" + crypto.randomUUID(),
      };
      const response = await signedKalshiRequest(env, "POST", "/portfolio/events/orders", body);
      const order = response.order || response;
      const filled = Number(order.fill_count_fp ?? order.fill_count ?? 0);
      return json({
        environment:"DEMO", supervised:true, intent, direction, ticker,
        kalshiSide:side, yesBookLimitPrice:yesPrice, requestedContractPrice:contractPrice,
        orderAccepted:true, fillCount:filled, fullyFilled:filled >= 1,
        orderId:order.order_id || null, order,
        note:filled >= 1 ? "Kalshi reports a full one-contract fill. Refresh positions and fills to independently verify." : "Order accepted but no full fill is confirmed in the immediate response. Check orders and fills before any further action."
      }, 201, allowedOrigin);
    }

    if (url.pathname === "/kalshi/order" && request.method === "POST") {
      return json({error:"Order execution is temporarily locked while position-aware entry/exit mapping and fill-based loss controls are being validated. No order was sent."}, 423, allowedOrigin);
      const input = await request.json();
      const ticker = String(input.ticker || "").trim();
      const side = String(input.side || "");
      const count = Number(input.count);
      const price = Number(input.price);
      if (!ticker || !/^[A-Z0-9_-]{3,80}$/.test(ticker)) throw new Error("Choose a valid Kalshi market.");
      if (!["bid","ask"].includes(side)) throw new Error("Side must be bid (buy YES) or ask (sell YES).");
      if (!Number.isFinite(count) || count !== 1) throw new Error("Demo safety limit: exactly 1 contract per test order.");
      if (!Number.isFinite(price) || price < 0.01 || price > 0.99) throw new Error("Limit price must be between $0.01 and $0.99.");
      if (input.confirmDemoOrder !== true) throw new Error("Order not sent: explicit demo confirmation is required.");
      if (side === "bid") {
        const risk = await getRiskSnapshot(env);
        if (!risk.entryAllowed) throw new Error("DEMO entry blocked by server safety checks: daily drawdown, existing position, or resting order limit.");
        if (price * count > risk.maxEntryCost) throw new Error("DEMO entry blocked: maximum entry cost is $1.00.");
      }
      const marketResponse = await fetch(BASE + "/markets/" + encodeURIComponent(ticker), {headers:{"Accept":"application/json"}});
      const marketData = await marketResponse.json();
      if (!marketResponse.ok) throw new Error("Could not verify market status; order blocked.");
      const market = marketData.market || marketData;
      const marketStatus = String(market.status || "").toLowerCase();
      const closeTime = market.close_time ? Date.parse(market.close_time) : NaN;
      if (!["open","active"].includes(marketStatus) || !Number.isFinite(closeTime) || closeTime <= Date.now()) {
        throw new Error("Order blocked: this market is not active and unexpired.");
      }
      const body = {
        ticker, side, count:"1", price:price.toFixed(4),
        time_in_force:"good_till_canceled",
        self_trade_prevention_type:"taker_at_cross",
        client_order_id:"btc-demo-" + crypto.randomUUID(),
      };
      const data = await signedKalshiRequest(env, "POST", "/portfolio/events/orders", body);
      return json({environment:"DEMO", accepted:true, order:data}, 201, allowedOrigin);
    }

    if (url.pathname.startsWith("/kalshi/cancel/") && request.method === "DELETE") {
      const orderId = decodeURIComponent(url.pathname.slice("/kalshi/cancel/".length));
      if (!/^[a-zA-Z0-9-]{8,100}$/.test(orderId)) throw new Error("Invalid order ID.");
      const data = await signedKalshiRequest(env, "DELETE", "/portfolio/events/orders/" + encodeURIComponent(orderId));
      return json({environment:"DEMO", canceled:true, result:data}, 200, allowedOrigin);
    }

    return json({error:"Unknown Kalshi demo endpoint."}, 404, allowedOrigin);
  } catch (error) {
    return json({error:error && error.message ? error.message : "Kalshi demo request failed."}, 400, allowedOrigin);
  }
}
