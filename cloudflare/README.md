# BTC PolyBolt TWAP relay

This Cloudflare Worker keeps Polymarket API credentials on the server. The GitHub Pages dashboard connects to this Worker; it must never connect to PolyBolt using the credentials directly.

## What it does

- Connects to `wss://ws-live-v2.polymarket.com/ws`.
- Authenticates using the three server-side CLOB API credential secrets.
- Waits for the authentication acknowledgement before subscribing.
- Subscribes only to BTC/USD 60-second Chainlink TWAP.
- Waits for the subscription acknowledgement and a real TWAP sample.
- Forwards only that TWAP channel to the browser.
- Does not place or manage any trades.

## Deploy it

1. Sign in to Cloudflare and open **Workers & Pages**.
2. Install Wrangler on your computer or use Cloudflare's supported terminal. In this folder, run `npx wrangler login`.
3. Add the credentials one at a time. Use the CLOB API key, API secret, and API passphrase — **not** your wallet private key or recovery phrase:

   ```sh
   npx wrangler secret put POLYMARKET_API_KEY
   npx wrangler secret put POLYMARKET_API_SECRET
   npx wrangler secret put POLYMARKET_PASSPHRASE
   ```

4. Deploy from this folder:

   ```sh
   npx wrangler deploy
   ```

5. Cloudflare will show a Worker URL similar to `https://btc-polybolt-twap-relay.<your-account>.workers.dev`. The WebSocket address is that same host with `wss://` and the `/twap` path, for example `wss://btc-polybolt-twap-relay.<your-account>.workers.dev/twap`.
6. Check the health endpoint with the same host plus `/health`. It should return `ok: true`.
7. Send me the Worker URL. I will put it in the dashboard's relay setting and verify the browser connection.

## Security notes

- Never place API key, secret, or passphrase in `index.html`, GitHub Pages, or a committed file.
- Keep the Worker secrets in Cloudflare's secret store.
- The Worker checks the dashboard's browser Origin and forwards only the BTC/USD 60-second TWAP. Origin checks help limit accidental use, but are not user authentication.
- If you rotate the Polymarket API credentials, update all three Worker secrets.

## Local config

The Worker uses `ALLOWED_ORIGIN` from `wrangler.toml`. The default is this project's GitHub Pages origin. Change it only if the website hostname changes.
