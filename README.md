# Swap Intent Sender

PoC for creating and submitting swap intents on the SODAX protocol. Intents are built and broadcast on-chain via `@sodax/sdk` (v2), then submitted to the SODAX **swaps v2** backend for asynchronous execution.

> **Targets swaps v2.** Submission goes to `POST /v1/swaps/submit-tx` (the legacy `/v1/bes/swaps/*` path is retired → gateway 404), keyed by `srcChainKey` (a SODAX `SpokeChainKey` such as `sonic`, `0xa4b1.arbitrum`) — renamed from v1's `srcChainId`. **Status is polled primarily from the swaps-api `GET /v1/swaps/submit-tx/status`** (the endpoint under test), then **cross-checked once against the intent journal via apps/api** (`GET /intent/tx/:txHash` or `GET /intent/:intentHash`) for independent on-chain confirmation. Requires `@sodax/sdk` `2.0.0-rc.11`.

Also includes a **chain hop** demo that moves funds across 11 EVM chains using the `@sodax/sdk`.

> 📖 **Building a bot against the swaps endpoint?** Read [`INSTRUCTIONS.md`](./INSTRUCTIONS.md) — a concise integration guide (build intent → `submit-tx` → poll status) with exact payload/response shapes and operational gotchas.

## Prerequisites

- Node.js >= 18
- pnpm

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with your private key and configuration
```

## Environment Variables

See `.env.example` for all available variables. Key ones:

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | Wallet private key |
| `BACKEND_SWAP_ENDPOINT` | No | Swaps v2 base URL for `submit-tx` + primary status poll (default: `https://canary-api.sodax.com/v1/swaps`) |
| `INTENT_API_ENDPOINT` | No | apps/api base URL for the journal cross-check (default: `https://apiv1-1.coolify.iconblockchain.xyz`, the canary deployment) |
| `JOURNAL_CROSSCHECK_TIMEOUT_MS` | No | Max wait for the journal to catch up during the cross-check (default: `90000`; a timeout is logged as inconclusive, never fatal) |
| `INPUT_AMOUNT_HUMAN` | No | Swap amount in human units (default: `1`) |
| `MIN_OUTPUT_SLIPPAGE_BPS` | No | Slippage in basis points (default: `500` = 5%) |
| `AUTO_APPROVE` | No | Auto-approve ERC20 spending (default: `true`) |
| `POLL_INTERVAL_MS` | No | Status poll interval (default: `3000`) |
| `POLL_TIMEOUT_MS` | No | Status poll timeout (default: `120000`) |
| `DISABLED_CHAINS` | No | JSON array of chain keys to skip (e.g., `["optimism","redbelly"]`) |
| `<CHAIN>_RPC_URL` | No | RPC override per chain (e.g., `BASE_RPC_URL`) |

## Scripts

### Swap (Sonic same-chain)

| Command | Description |
|---|---|
| `pnpm start` | Full flow: approve → create → submit → poll (USDT→USDC) |
| `pnpm sonic-usdt-to-usdc` | Same as start |
| `pnpm sonic-usdc-to-usdt` | Full flow for USDC→USDT |
| `pnpm cancel <intentId>` | Cancel a pending (open) intent created by this wallet |

### Cancel a pending intent

```bash
pnpm cancel 30003198628197127137637480263704227607279888124613254871517565769320775527350
```

Resolves the `intentId` to its full `Intent` struct via the journal (`GET {INTENT_API_ENDPOINT}/intent/user/:wallet`, scanning the wallet's latest ~100 intents), derives the source chain from the intent's relay chain id, then broadcasts the cancel via `sodax.swaps.cancelIntent` and confirms the on-chain `intent-cancelled` in the journal. Only the **creator** can cancel, so it must run with the same `PRIVATE_KEY` that created the intent. If the intent is already filled/cancelled (`open: false`) it reports that and exits without sending a tx.

### Chain Hop — Forward

| Command | Description |
|---|---|
| `pnpm chain-hop` | Run all 11 forward hops sequentially |
| `pnpm hop-sonic-to-base` | USDT(Sonic) → ETH(Base) |
| `pnpm hop-base-to-optimism` | ETH(Base) → ETH(Optimism) |
| `pnpm hop-optimism-to-arbitrum` | ETH(Optimism) → ETH(Arbitrum) |
| `pnpm hop-arbitrum-to-avalanche` | ETH(Arbitrum) → AVAX(Avalanche) |
| `pnpm hop-avalanche-to-bsc` | AVAX(Avalanche) → BNB(BSC) |
| `pnpm hop-bsc-to-polygon` | BNB(BSC) → POL(Polygon) |
| `pnpm hop-polygon-to-ethereum` | POL(Polygon) → ETH(Ethereum) |
| `pnpm hop-ethereum-to-hyper` | ETH(Ethereum) → HYPE(Hyperliquid) |
| `pnpm hop-hyper-to-lightlink` | HYPE(Hyperliquid) → ETH(LightLink) |
| `pnpm hop-lightlink-to-redbelly` | ETH(LightLink) → RBNT(Redbelly) |
| `pnpm hop-redbelly-to-kaia` | RBNT(Redbelly) → KAIA(Kaia) |

### Chain Hop — Return (back to USDT on Sonic)

| Command | Description |
|---|---|
| `pnpm hop-base-to-sonic` | ETH(Base) → USDT(Sonic) |
| `pnpm hop-optimism-to-sonic` | ETH(Optimism) → USDT(Sonic) |
| `pnpm hop-arbitrum-to-sonic` | ETH(Arbitrum) → USDT(Sonic) |
| `pnpm hop-avalanche-to-sonic` | AVAX(Avalanche) → USDT(Sonic) |
| `pnpm hop-bsc-to-sonic` | BNB(BSC) → USDT(Sonic) |
| `pnpm hop-polygon-to-sonic` | POL(Polygon) → USDT(Sonic) |
| `pnpm hop-ethereum-to-sonic` | ETH(Ethereum) → USDT(Sonic) |
| `pnpm hop-hyper-to-sonic` | HYPE(Hyperliquid) → USDT(Sonic) |
| `pnpm hop-lightlink-to-sonic` | ETH(LightLink) → USDT(Sonic) |
| `pnpm hop-redbelly-to-sonic` | RBNT(Redbelly) → USDT(Sonic) |
| `pnpm hop-kaia-to-sonic` | KAIA(Kaia) → USDT(Sonic) |

### Utilities

| Command | Description |
|---|---|
| `pnpm balances` | Show native balance on every chain + USDT on Sonic |
| `pnpm sweep` | Swap all remote native balances back to USDT on Sonic |

### Dev

| Command | Description |
|---|---|
| `pnpm checkTs` | Type-check without emitting |
| `pnpm format` | Prettier format all .ts/.json files |
| `pnpm format:check` | Check formatting |

## Architecture

1. **Approve** ERC20 token spending (if needed; spender = the SDK's intents contract)
2. **Create intent** — `sodax.swaps.createIntent({ params, walletProvider })` builds and broadcasts the create-intent tx, returning `{ tx, intent, relayData }` (the SDK fills in the relay chain ids and relay data, so there is no manual receipt decode)
3. **Submit** `{ txHash, srcChainKey, walletAddress, intent, relayData }` to `POST /v1/swaps/submit-tx` (triggers the relay + solver execution)
4. **Poll status (primary)** — `GET /v1/swaps/submit-tx/status?txHash=…&srcChainKey=…` until terminal (`executed` / `failed`). This is the swaps-api's own pipeline view: `pending → relaying → relayed → posting_execution → executed | failed`, with `failedAtStep` / `failureReason` / `userMessage` / `intentCancelled` on failure.
5. **Cross-check the intent journal (apps/api)** for independent on-chain confirmation:
   - same-chain (Sonic source): `GET {INTENT_API_ENDPOINT}/intent/tx/:txHash` — the broadcast tx is the hub intent tx, so this is instance-precise
   - cross-chain: `GET {INTENT_API_ENDPOINT}/intent/:intentHash` (`intentHash = sodax.swaps.getIntentHash(intent)`) — the broadcast tx is on a spoke chain, while the journal is keyed by the hub tx

**Why both:** `submit-tx/status` is the endpoint under test (exact keying, reports *why* a swap failed — the journal can't, and for cross-chain a relay failure means nothing ever lands in the journal). The journal is independent on-chain ground truth, so it guards against the circularity of trusting the swaps-api's own self-report. Journal lifecycle: `404` (not yet observed on-chain) → `open: true` → `open: false` (terminal `intent-filled` / `intent-cancelled`); `packetData` carries the cross-chain delivery proof. The cross-check is soft — if the aggregator lags past `JOURNAL_CROSSCHECK_TIMEOUT_MS` it's logged as inconclusive, never fatal. The journal is on-chain-derived, so it is identical across all deployments.

## Chain Hop Sequence

```
Sonic(USDT) → Base(ETH) → Optimism(ETH) → Arbitrum(ETH) → Avalanche(AVAX)
  → BSC(BNB) → Polygon(POL) → Ethereum(ETH) → Hyperliquid(HYPE)
  → LightLink(ETH) → Redbelly(RBNT) → Kaia(KAIA)
```

Chains can be skipped at runtime via `DISABLED_CHAINS`. The hop sequence auto-rewires around disabled chains (e.g., disabling `optimism` makes Base hop directly to Arbitrum).
