# BTC PolyBolt TWAP relay

This Worker safely connects the public GitHub Pages dashboard to Polymarket's authenticated PolyBolt feed. Your Polymarket API credentials stay in Cloudflare's secret store and are never put in `index.html`.

## Easiest setup: Cloudflare dashboard

1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/) and go to **Workers & Pages**.
2. Choose **Create application** → **Create Worker**. Name it `btc-polybolt-twap-relay` and deploy the starter Worker.
3. Open the new Worker and choose **Edit code** (or **Quick Edit**).
4. In this GitHub repository, open `cloudflare/polybolt-relay.js`. Copy that file's complete contents, replace the starter code in Cloudflare, and choose **Save and deploy**.
5. Open the Worker **Settings** → **Variables and Secrets**. Add these three values as **Secrets**, one at a time:
   - `POLYMARKET_API_KEY`
   - `POLYMARKET_API_SECRET`
   - `POLYMARKET_PASSPHRASE`
6. Save the settings. Cloudflare's default allowed website origin is already set in the Worker code to `https://dustin465-coder.github.io`.
7. Your Worker URL will look similar to `https://btc-polybolt-twap-relay.<your-account>.workers.dev`. Open that address with `/health` at the end; it should return `ok: true`.
8. The dashboard's WebSocket address will be the same host, but use `wss://` and end it with `/twap`, for example `wss://btc-polybolt-twap-relay.<your-account>.workers.dev/twap`.
9. Send me that final `wss://.../twap` address. I can then put it into the dashboard and verify the live browser feed.

## Also enable the GitHub recorder

The scheduled checkpoint recorder is a separate server-side connection running in GitHub Actions. In the GitHub repository, open **Settings** → **Secrets and variables** → **Actions** and add the same three credential values as repository secrets with the exact names above. That enables the scheduled recorder to use PolyBolt directly.

The Cloudflare secrets and GitHub Actions secrets are stored separately. The same values need to be added in both places for both pieces to use PolyBolt.

## Credential safety

- Use the Polymarket CLOB API key, API secret, and passphrase.
- **Never** use or share your wallet private key or recovery phrase.
- Never paste credentials into chat, `index.html`, or a committed file.
- The Worker checks the website Origin to reduce accidental cross-site use, but that is not user authentication. It forwards only BTC/USD 60-second TWAP data and does not place or manage trades.

## Optional command-line deployment

From this folder, run `npx wrangler login`, add the three values with `npx wrangler secret put SECRET_NAME` (one command per name), then run `npx wrangler deploy`.
