# Swap Intent Sender

PoC for creating and submitting swap intents on the SODAX protocol. Intents are created on-chain on Sonic (chain 146) via a smart contract, then submitted to the SODAX backend for asynchronous execution.

Also includes a **chain hop** demo that moves funds across 11 EVM chains using the `@sodax/sdk`.

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
| `INTENT_CONTRACT_ADDRESS` | Yes | Intent contract on Sonic |
| `BACKEND_SWAP_ENDPOINT` | No | Backend URL (default: `https://canary-api.sodax.com/v1/bes/swaps`) |
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

1. **Approve** ERC20 token spending (if needed)
2. **Create intent** on-chain via the intent contract / SDK
3. **Extract** `IntentCreated` event from the transaction receipt
4. **Submit** decoded intent data to the SODAX backend (`POST /submit-tx`)
5. **Poll** execution status until terminal state (`GET /submit-tx/status`)

## Chain Hop Sequence

```
Sonic(USDT) → Base(ETH) → Optimism(ETH) → Arbitrum(ETH) → Avalanche(AVAX)
  → BSC(BNB) → Polygon(POL) → Ethereum(ETH) → Hyperliquid(HYPE)
  → LightLink(ETH) → Redbelly(RBNT) → Kaia(KAIA)
```

Chains can be skipped at runtime via `DISABLED_CHAINS`. The hop sequence auto-rewires around disabled chains (e.g., disabling `optimism` makes Base hop directly to Arbitrum).
