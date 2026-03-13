# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PoC for creating and submitting swap intents on the SODAX protocol. Intents are created on-chain on **Sonic (chain 146)** via a smart contract, then submitted to the SODAX backend for asynchronous execution.

## Commands

```bash
pnpm install                # Install dependencies
pnpm start                  # Full flow: approve -> create -> submit -> poll (USDT->USDC)
pnpm sonic-usdt-to-usdc     # Same as start
pnpm sonic-usdc-to-usdt     # Full flow for USDC->USDT
pnpm checkTs                # Type-check without emitting
pnpm format                 # Prettier format all .ts/.json files
pnpm format:check           # Check formatting (CI use)
```

## Architecture

**Flow:** Approve ERC20 -> Create on-chain intent -> Extract IntentCreated event -> Submit to backend -> Poll status

### Key files

| File | Role |
|---|---|
| `main.ts` | CLI entry point with flag parsing, orchestrates the full 5-step flow |
| `helpers.ts` | Env helpers, ERC20/approval utils, intent decoding, backend interaction, types/constants |
| `intents.abi.ts` | Full ABI for the Intent smart contract (auto-generated, do not edit manually) |

### Pipeline steps (in main.ts)

1. **Check balance & approve** — Read ERC20 balance/allowance, approve if needed
2. **Create intent on-chain** — Call `createIntent()` on the intent contract
3. **Extract intent from receipt** — Decode `IntentCreated` event from tx receipt
4. **Submit to backend** — POST decoded intent data to `BACKEND_SWAP_ENDPOINT/submit-tx`
5. **Poll status** — GET `BACKEND_SWAP_ENDPOINT/submit-tx/status` until terminal state

### CLI flags

- `--sonic-usdt-to-sonic-usdc` (default)
- `--sonic-usdc-to-sonic-usdt`

### Backend API

Base URL: `https://canary-api.sodax.com/v1/bes/swaps` (override with `BACKEND_SWAP_ENDPOINT`)
- `POST /submit-tx` — submit intent for processing
- `GET /submit-tx/status` — poll execution status

## Configuration

All runtime config is via `.env` file (loaded with dotenv). Key variables:

- `PRIVATE_KEY` — wallet private key (required)
- `INTENT_CONTRACT_ADDRESS` — deployed intent contract on Sonic (required)
- `BACKEND_SWAP_ENDPOINT` — backend base URL
- `SONIC_RPC_URL` — RPC endpoint (default: `https://rpc.soniclabs.com`)
- `SRC_CHAIN` / `DST_CHAIN` — chain IDs (default: 146, Sonic)
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
