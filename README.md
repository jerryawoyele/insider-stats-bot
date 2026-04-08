# Insider Bot

A fresh Node-based Solana bot scaffold for discovering:

- token create transactions from a `CONFIG_ADDRESS`
- the token mint and dev wallet
- the initial pool
- the migration pool
- insider wallets funded by the dev before the token create

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `HELIUS_API_KEY`
   - `LEADER_WALLET`
   - `CONFIG_ADDRESS`
3. Run:

```bash
npm start
```

## Fly.io Deploy

This bot is a background worker, so it should be deployed on Fly.io without public HTTP services.

1. Install `flyctl`
2. Login:

```bash
fly auth login
```

3. Create the app without auto-generated web config:

```bash
fly launch --no-deploy
```

If Fly asks to add services, skip that. This repo already includes a worker-style [`fly.toml`](C:\Users\Jerry A\Projects\Insider-bot\fly.toml) and [`Dockerfile`](C:\Users\Jerry A\Projects\Insider-bot\Dockerfile).

4. Set secrets:

```bash
fly secrets set HELIUS_API_KEY=... LEADER_WALLET=... CONFIG_ADDRESS=... GMGN_API_KEY=...
```

`GMGN_API_KEY` is optional but recommended if you want holder counts from GMGN. The deploy bootstrap writes it to the config path `gmgn-cli` expects inside the container.

Optional non-secret env values can stay in `fly.toml` or be set with:

```bash
fly secrets set HELIUS_RPC_URL=https://api-mainnet.helius-rpc.com/ HELIUS_WSS_URL=wss://mainnet.helius-rpc.com/?api-key=...
```

5. Deploy:

```bash
fly deploy
```

6. Check logs:

```bash
fly logs
```

7. Scale to a single worker machine if needed:

```bash
fly scale count 1
```

## Current Behavior

- Subscribes to `logsSubscribe` with `mentions: [CONFIG_ADDRESS]`
- Batches signatures from log events and resolves them through Helius `v0/transactions`
- Detects:
  - token create txs
  - initial pool txs
  - migration txs
- Fetches dev wallet history before the create signature to derive insider wallets
- Starts live pool log subscriptions for the discovered pools
- Resolves pool signatures in batches through Helius `v0/transactions`
- Tracks insider buys, sells, SOL totals, and dominance through the first `POOL_TX_TARGET` pool txs
- Accepts when insider dominance is `>= 90%`, otherwise rejects

## Notes

- Once both the initial pool and migration pool are found for the current token, config-address txs are ignored until a new token create tx appears.
- Pool activity uses websocket subscriptions plus batched enhanced parsing instead of paginated pool history fetches to reduce credit pressure on lower Helius plans.
