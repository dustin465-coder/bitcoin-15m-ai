const POLYBOLT_URL = "wss://ws-live-v2.polymarket.com/ws";
const AUTH_RID = "polybolt-relay-auth";
const SUBSCRIBE_RID = "polybolt-relay-price";

function status(socket, state, detail = "") {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "relay_status",
    state,
    detail: detail || undefined,
    at: Date.now(),
  }));
}

function safeClose(socket, code = 1011, reason = "Upstream feed unavailable") {
  try {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(code, reason);
  } catch {}
}

function parseMessage(data) {
  try {
    if (typeof data === "string") return JSON.parse(data);
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "PolyBolt BTC and Gold relay" });
    }

    const isGold = url.pathname === "/gold";
    const isBtc = url.pathname === "/twap";
    if (!isGold && !isBtc) {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    // Limit browser access to this public dashboard. This protects against
    // accidental cross-site use; it is not a substitute for Cloudflare Access.
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://dustin465-coder.github.io";
    if (request.headers.get("Origin") !== allowedOrigin) {
      return new Response("Origin not allowed", { status: 403 });
    }

    const apiKey = env.POLYMARKET_API_KEY;
    const secret = env.POLYMARKET_API_SECRET;
    const passphrase = env.POLYMARKET_PASSPHRASE;
    if (!apiKey || !secret || !passphrase) {
      return new Response("PolyBolt credentials are not configured on this Worker", { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let upstream = null;
    let authTimer = null;
    let subscriptionTimer = null;
    let sampleTimer = null;
    let isSubscribed = false;
    let gotSample = false;
    let closed = false;

    const clearTimers = () => {
      clearTimeout(authTimer);
      clearTimeout(subscriptionTimer);
      clearTimeout(sampleTimer);
    };

    const fail = (code, detail) => {
      if (closed) return;
      status(server, "error", code + (detail ? ": " + detail : ""));
      closed = true;
      clearTimers();
      safeClose(upstream);
      safeClose(server);
    };

    const sendSubscription = () => {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        fail("upstream_not_open");
        return;
      }
      upstream.send(JSON.stringify({
        op: "subscribe",
        rid: SUBSCRIBE_RID,
        subscriptions: [{
          channel: isGold ? "price.equity" : "price.crypto.twap",
          filter: isGold ? { symbol: "xauusd" } : { symbol: "btcusd", window_seconds: 60 },
        }],
      }));
      subscriptionTimer = setTimeout(() => fail("subscribe_timeout"), 12000);
    };

    status(server, "connecting");
    try {
      upstream = new WebSocket(POLYBOLT_URL);
    } catch {
      fail("upstream_connect_failed");
      return new Response(null, { status: 101, webSocket: client });
    }

    upstream.addEventListener("open", () => {
      if (closed) return;
      status(server, "connected");
      upstream.send(JSON.stringify({
        op: "auth",
        rid: AUTH_RID,
        auth: { apiKey, secret, passphrase },
      }));
      authTimer = setTimeout(() => fail("auth_timeout"), 12000);
    });

    upstream.addEventListener("message", (event) => {
      if (closed) return;
      const message = parseMessage(event.data);
      if (!message) return;

      if (message.op === "error") {
        fail("polybolt_error", String(message.code || "unknown_error"));
        return;
      }

      if (message.op === "authed") {
        if (message.rid && message.rid !== AUTH_RID) return;
        clearTimeout(authTimer);
        status(server, "authenticated");
        sendSubscription();
        return;
      }

      if (message.op === "subscribed") {
        if (message.rid && message.rid !== SUBSCRIBE_RID) return;
        if (message.channel && message.channel !== TWAP_CHANNEL) return;
        isSubscribed = true;
        clearTimeout(subscriptionTimer);
        status(server, "subscribed");
        sampleTimer = setTimeout(() => {
          if (!gotSample) fail("first_twap_sample_timeout");
        }, 15000);
        return;
      }

      const expectedChannel = isGold ? "price.equity" : "price.crypto.twap";
      const expectedSymbol = isGold ? "xauusd" : "btcusd";
      if (message.channel !== expectedChannel) return;
      const payload = message.payload || {};
      if (String(payload.symbol || "").toLowerCase() !== expectedSymbol) return;
      if (!isGold && payload.window_seconds != null && Number(payload.window_seconds) !== 60) return;
      if (isGold && payload.source && String(payload.source).toLowerCase() !== "chainlink") {
        // Do not forward a non-Chainlink quote as if it were the market's settlement feed.
        return;
      }
      if (!isSubscribed) return;

      gotSample = true;
      clearTimeout(sampleTimer);
      if (server.readyState === WebSocket.OPEN) {
        // Forward only the requested BTC TWAP or Chainlink XAU/USD reference-price channel.
        server.send(JSON.stringify(message));
      }
    });

    upstream.addEventListener("error", () => fail("upstream_socket_error"));
    upstream.addEventListener("close", (event) => {
      if (closed) return;
      fail("upstream_closed", "code " + event.code);
    });

    server.addEventListener("close", () => {
      closed = true;
      clearTimers();
      safeClose(upstream, 1000, "Browser disconnected");
    });
    server.addEventListener("error", () => {
      closed = true;
      clearTimers();
      safeClose(upstream);
    });

    return new Response(null, { status: 101, webSocket: client });
  },
};
