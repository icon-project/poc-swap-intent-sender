# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PoC for creating and submitting swap intents on the SODAX protocol. Intents are built and broadcast on-chain via `@sodax/sdk` **v2** (`2.0.0-rc.11`), then submitted to the SODAX **swaps v2** backend (`/v1/swaps`) for asynchronous execution.

> **Integrating a bot?** See [`INSTRUCTIONS.md`](./INSTRUCTIONS.md) — a concise, bot-oriented guide to the swaps endpoint (build intent → `submit-tx` → poll `submit-tx/status`), with exact payload/response shapes and operational gotchas.

**Swaps v2 vs v1 (what changed in this PoC):**
- Backend base path `/v1/bes/swaps` → `/v1/swaps` (the old path is retired → gateway 404).
- `submit-tx` body + `submit-tx/status` query: `srcChainId` → **`srcChainKey`** (a `SpokeChainKey`, e.g. `sonic`, `0xa4b1.arbitrum`).
- **Status: primary = swaps-api `GET /submit-tx/status`** (the endpoint under test — exact `(txHash, srcChainKey)` keying, reports `failedAtStep`/`failureReason`/`userMessage`/`intentCancelled`). **Then a single soft cross-check against the intent journal via apps/api** (`GET /intent/tx/:txHash` for Sonic-source, `GET /intent/:intentHash` for cross-chain) for independent on-chain confirmation. The journal is on-chain-derived and identical across deployments; the cross-check never fails the run (aggregator lag → logged inconclusive).
- `@sodax/sdk` `1.3.0-beta` → `2.0.0-rc.11`: `createIntent` now takes `{ params, walletProvider }` (no hand-built `SpokeProvider`), `CreateIntentParams` uses `srcChainKey`/`dstChainKey`, and the result is `{ tx, intent, relayData }` (object, not a tuple). `getSolverConfig()` takes no args.
- The intent is built by the SDK (correct relay chain ids + relay data), so the old on-chain `IntentCreated` receipt decode and `INTENT_CONTRACT_ADDRESS` env are gone. `intents.abi.ts` is no longer imported (kept for reference only).

## Commands

```bash
pnpm install                # Install dependencies
pnpm start                  # Full flow: approve -> create -> submit -> poll (USDT->USDC)
pnpm sonic-usdt-to-usdc     # Same as start
pnpm sonic-usdc-to-usdt     # Full flow for USDC->USDT
pnpm cancel <intentId>      # Cancel a pending (open) intent created by this wallet
pnpm checkTs                # Type-check without emitting
pnpm format                 # Prettier format all .ts/.json files
pnpm format:check           # Check formatting (CI use)
```

## Architecture

**Flow:** Approve ERC20 -> SDK builds + broadcasts create-intent tx -> Submit to swaps v2 backend -> Poll status

### Key files

| File | Role |
|---|---|
| `main.ts` | CLI entry point with flag parsing, orchestrates the 5-step Sonic same-chain flow via the SDK |
| `cancel.ts` | `pnpm cancel <intentId>` — resolves the id via the journal, then `sodax.swaps.cancelIntent` |
| `helpers.ts` | Env helpers, ERC20/approval utils, `buildSubmitPayload`, submit/poll, `findIntentById`/`journalIntentToSdkIntent`, types/constants |
| `sdk-helpers.ts` | `ViemWalletProvider` (`IEvmWalletProvider`), chain registry, balance helpers, disabled-chain logic |
| `chain-hop.ts` | Cross-chain hop demo (also targets swaps v2) |
| `intents.abi.ts` | Full ABI for the Intent contract (auto-generated). No longer imported — kept for reference. |

### Pipeline steps (in main.ts)

1. **Check balance & approve** — read ERC20 balance/allowance, approve the SDK intents contract if needed
2. **Create intent** — `sodax.swaps.createIntent({ params, walletProvider })` builds + broadcasts the tx, returns `{ tx, intent, relayData }`
3. **Submit to backend** — POST `{ txHash, srcChainKey, walletAddress, intent, relayData }` to `BACKEND_SWAP_ENDPOINT/submit-tx`
4. **Poll status (primary)** — GET `BACKEND_SWAP_ENDPOINT/submit-tx/status?txHash=…&srcChainKey=…` until terminal (`executed`/`failed`)
5. **Cross-check journal (soft)** — GET `INTENT_API_ENDPOINT/intent/tx/:txHash` (or `/intent/:intentHash`) for independent on-chain confirmation; bounded by `JOURNAL_CROSSCHECK_TIMEOUT_MS`, never fatal

### CLI flags

- `--sonic-usdt-to-sonic-usdc` (default)
- `--sonic-usdc-to-sonic-usdt`

### Backend APIs

**Submission + primary status — swaps v2** (`BACKEND_SWAP_ENDPOINT`, default `https://canary-api.sodax.com/v1/swaps`)
- `POST /submit-tx` — submit intent for processing (idempotent on `(txHash, srcChainKey)`; throttled 10/min/IP)
- `GET /submit-tx/status?txHash=…&srcChainKey=…` — pipeline status (`pending → relaying → relayed → posting_execution → executed | failed`) with failure diagnostics. **Primary** poll signal.

**Cross-check status — intent journal via apps/api** (`INTENT_API_ENDPOINT`, default `https://apiv1-1.coolify.iconblockchain.xyz`, the canary deployment)
- `GET /intent/tx/:txHash` — instance-precise; use when the broadcast tx is the hub intent tx (Sonic source)
- `GET /intent/:intentHash` — for cross-chain (broadcast tx is on a spoke; `intentHash = sodax.swaps.getIntentHash(intent)`). `findOne` by hash returns the latest instance.
- Lifecycle: 404 (not yet on-chain) → `open: true` → `open: false` (terminal `intent-filled` / `intent-cancelled`); `packetData` carries cross-chain delivery proof. Used as a single soft confirmation after the primary poll terminates.

## Configuration

All runtime config is via `.env` file (loaded with dotenv). Key variables:

- `PRIVATE_KEY` — wallet private key (required)
- `BACKEND_SWAP_ENDPOINT` — swaps v2 base URL (default: `https://canary-api.sodax.com/v1/swaps`)
- `SONIC_RPC_URL` — RPC endpoint (default: `https://rpc.soniclabs.com`)
- `INPUT_AMOUNT_HUMAN` — human-readable amount (default: "1") OR `INPUT_AMOUNT` for raw base units
- `MIN_OUTPUT_SLIPPAGE_BPS` — slippage in basis points (default: 500 = 5%)
- `AUTO_APPROVE=true` — auto-approve ERC20 spending
- `POLL_INTERVAL_MS` / `POLL_TIMEOUT_MS` — polling config

## Token addresses (Sonic)

- USDC: `0x29219dd400f2Bf60E5a23d13Be72B486D4038894`
- USDT: `0x6047828dc181963ba44974801ff68e538da5eaf9`

## Chain Hop (cross-chain via @sodax/sdk)

Demonstrates cross-chain hopping: USDT on Sonic → native gas token on each supported EVM chain.

### Commands

```bash
pnpm balances                   # Show native balance on every chain + USDT on Sonic
pnpm sweep                      # Swap all remote native balances back to USDT on Sonic
pnpm chain-hop                  # Run all 11 forward hops sequentially (--all)
pnpm hop-sonic-to-base          # USDT(Sonic) → ETH(Base)
pnpm hop-base-to-optimism       # ETH(Base) → ETH(Optimism)
pnpm hop-optimism-to-arbitrum   # ETH(Optimism) → ETH(Arbitrum)
pnpm hop-arbitrum-to-avalanche  # ETH(Arbitrum) → AVAX(Avalanche)
pnpm hop-avalanche-to-bsc       # AVAX(Avalanche) → BNB(BSC)
pnpm hop-bsc-to-polygon         # BNB(BSC) → POL(Polygon)
pnpm hop-polygon-to-ethereum    # POL(Polygon) → ETH(Ethereum)
pnpm hop-ethereum-to-hyper      # ETH(Ethereum) → HYPE(Hyperliquid)
pnpm hop-hyper-to-lightlink     # HYPE(Hyperliquid) → ETH(LightLink)
pnpm hop-lightlink-to-redbelly  # ETH(LightLink) → RBNT(Redbelly)
pnpm hop-redbelly-to-kaia       # RBNT(Redbelly) → KAIA(Kaia)
# Return hops (back to USDT on Sonic)
pnpm hop-base-to-sonic          # ETH(Base) → USDT(Sonic)
pnpm hop-optimism-to-sonic      # ETH(Optimism) → USDT(Sonic)
pnpm hop-arbitrum-to-sonic      # ETH(Arbitrum) → USDT(Sonic)
pnpm hop-avalanche-to-sonic     # AVAX(Avalanche) → USDT(Sonic)
pnpm hop-bsc-to-sonic           # BNB(BSC) → USDT(Sonic)
pnpm hop-polygon-to-sonic       # POL(Polygon) → USDT(Sonic)
pnpm hop-ethereum-to-sonic      # ETH(Ethereum) → USDT(Sonic)
pnpm hop-hyper-to-sonic         # HYPE(Hyperliquid) → USDT(Sonic)
pnpm hop-lightlink-to-sonic     # ETH(LightLink) → USDT(Sonic)
pnpm hop-redbelly-to-sonic      # RBNT(Redbelly) → USDT(Sonic)
pnpm hop-kaia-to-sonic          # KAIA(Kaia) → USDT(Sonic)
```

### Key files

| File | Role |
|---|---|
| `chain-hop.ts` | CLI entry point, hop execution loop |
| `sdk-helpers.ts` | ViemWalletProvider, spoke provider factory, chain config, hop definitions |

### Hop sequence

Sonic(USDT) → Base(ETH) → Optimism(ETH) → Arbitrum(ETH) → Avalanche(AVAX) → BSC(BNB) → Polygon(POL) → Ethereum(ETH) → Hyperliquid(HYPE) → LightLink(ETH) → Redbelly(RBNT) → Kaia(KAIA)

### Env vars (optional RPC overrides)

```
BASE_RPC_URL, OPTIMISM_RPC_URL, ARBITRUM_RPC_URL, AVALANCHE_RPC_URL, BSC_RPC_URL, POLYGON_RPC_URL, ETHEREUM_RPC_URL, HYPER_RPC_URL, LIGHTLINK_RPC_URL, REDBELLY_RPC_URL, KAIA_RPC_URL
```

Reuses: `PRIVATE_KEY`, `SONIC_RPC_URL`, `INPUT_AMOUNT_HUMAN`, `POLL_TIMEOUT_MS`

### `DISABLED_CHAINS`

```bash
DISABLED_CHAINS='["optimism","redbelly"]'
```

JSON array of chain keys to disable at runtime. Valid keys: `base`, `optimism`, `arbitrum`, `avalanche`, `bsc`, `polygon`, `ethereum`, `hyper`, `lightlink`, `redbelly`, `kaia`. `sonic` cannot be disabled (hub chain). When running `--all`, the hop sequence auto-rewires around disabled chains. Unset or empty = all chains enabled.

## TypeScript

- Target: ES2022, Module: CommonJS, Strict mode enabled
- Runtime: `tsx` (TypeScript execution without compilation step)
- Package manager: `pnpm`
