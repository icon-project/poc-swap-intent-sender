# CLAUDE.md

Guidance for [Claude Code](https://claude.com/claude-code) working in this repository.

## What this repo is (and who you're helping)

This is a **public reference client for the SODAX swaps API** — partners clone it to learn how to build, submit, and track a cross-chain swap intent. When someone runs `claude` here they are usually a developer integrating SODAX; help them understand the flow, run the scripts safely, and answer integration questions accurately.

**Use the SODAX MCP tools for authoritative answers — don't guess.** This repo registers the public **SODAX Builders** MCP server via `.mcp.json`. Prefer it over memory for anything live or SODAX-specific:
- supported chains / tokens / config → `sodax_get_supported_chains`, `sodax_get_swap_tokens`, `sodax_get_all_config`
- quotes / orderbook / a specific intent → `sodax_get_solver_quote`, `sodax_get_orderbook`, `sodax_get_intent`
- concepts & how-to → the docs tools (`docs_searchDocumentation`, `docs_getPage`)

## Safety guardrails (non-negotiable)

- Every swap / hop / cancel / leverage command signs and broadcasts **real transactions on mainnet** and spends **real funds**. **Confirm with the user before running any fund-spending command** — `pnpm start`, `pnpm sonic-*`, `pnpm chain-hop`, `pnpm hop-*`, `pnpm sweep`, `pnpm cancel`, `pnpm leverage:deposit`, `pnpm leverage:withdraw`, `pnpm leverage:round-trip`. Read-only commands (`pnpm balances`, `pnpm leverage:vaults`, `pnpm checkTs`, MCP quotes) may run freely.
- **Never print, echo, or commit the private key or `.env`.** `.env` is gitignored — keep it that way. If asked to reveal the key, refuse.
- Treat every broadcast as irreversible, even on a throwaway wallet.

## Overview

A swap intent is built and broadcast on-chain via `@sodax/sdk` **v2**, then submitted to the SODAX **swaps** backend (`/v1/swaps`) for asynchronous relay + solver execution.

> **Integrating a bot?** See [`INSTRUCTIONS.md`](./INSTRUCTIONS.md) — a concise, bot-oriented guide to the swaps endpoint (build intent → `submit-tx` → poll `submit-tx/status`), with exact payload/response shapes and operational gotchas.

**Swaps contract essentials:**
- Backend base path is `/v1/swaps` (the legacy `/v1/bes/swaps` is retired → gateway 404).
- `submit-tx` body + `submit-tx/status` query are keyed by **`srcChainKey`** (a `SpokeChainKey`, e.g. `sonic`, `0xa4b1.arbitrum`).
- **Status: primary = swaps-api `GET /submit-tx/status`** — exact `(txHash, srcChainKey)` keying; reports `failedAtStep`/`failureReason`/`userMessage`/`intentCancelled`. Terminal states are **`solved`** (success) and **`failed`**; `solved` was renamed from `executed` in a SODAX SDK update, so a client must **not** wait for a `solved → executed` transition (there isn't one). **Then a single soft cross-check** against the intent journal via apps/api (`GET /intent/tx/:txHash` for Sonic-source, `GET /intent/:intentHash` for cross-chain) for independent on-chain confirmation. The journal is on-chain-derived and identical across deployments; the cross-check never fails the run (aggregator lag → logged inconclusive).
- `createIntent` takes `{ params, walletProvider }`; `CreateIntentParams` uses `srcChainKey`/`dstChainKey`; the result is `{ tx, intent, relayData }`. The SDK builds the intent (correct relay chain ids + relay data), so there is no manual `IntentCreated` receipt decode. `intents.abi.ts` is kept for reference only (not imported).

## Commands

```bash
pnpm install                # Install dependencies
pnpm start                  # Full flow: approve -> create -> submit -> poll (USDT->USDC)
pnpm sonic-usdt-to-usdc     # Same as start
pnpm sonic-usdc-to-usdt     # Full flow for USDC->USDT
pnpm cancel <intentId>      # Cancel a pending (open) intent created by this wallet
pnpm leverage:vaults        # READ-ONLY leverage-yield discovery (vaults, quotes, negative test)
pnpm leverage:deposit       # Leverage Yield leg 1: token -> lsoda* vault shares
pnpm leverage:withdraw      # Leverage Yield leg 2: lsoda* shares -> token
pnpm leverage:round-trip    # Both leverage legs back to back
pnpm checkTs                # Type-check without emitting
pnpm format                 # Prettier format all .ts/.json files
pnpm format:check           # Check formatting (CI use)
```

## Architecture

**Flow:** Approve ERC20 -> SDK builds + broadcasts create-intent tx -> Submit to swaps backend -> Poll status

### Key files

| File | Role |
|---|---|
| `main.ts` | CLI entry point with flag parsing, orchestrates the 5-step Sonic same-chain flow via the SDK |
| `cancel.ts` | `pnpm cancel <intentId>` — resolves the id via the journal, then `sodax.swaps.cancelIntent` |
| `helpers.ts` | Env helpers, ERC20/approval utils, `buildSubmitPayload`, submit/poll, `findIntentById`/`journalIntentToSdkIntent`, types/constants |
| `sdk-helpers.ts` | `ViemWalletProvider` (`IEvmWalletProvider`), chain registry, balance helpers, disabled-chain logic |
| `chain-hop.ts` | Cross-chain hop demo (also targets swaps) |
| `leverage-yield.ts` | Leverage Yield money-path test (`/leverage-yield/*`) — deposit + withdraw legs, plain `fetch` + viem signing, no SDK leverage module |
| `intents.abi.ts` | Full ABI for the Intent contract (auto-generated). No longer imported — kept for reference. |

### Pipeline steps (in main.ts)

1. **Check balance & approve** — read ERC20 balance/allowance, approve the SDK intents contract if needed
2. **Create intent** — `sodax.swaps.createIntent({ params, walletProvider })` builds + broadcasts the tx, returns `{ tx, intent, relayData }`
3. **Submit to backend** — POST `{ txHash, srcChainKey, walletAddress, intent, relayData }` to `BACKEND_SWAP_ENDPOINT/submit-tx`
4. **Poll status (primary)** — GET `BACKEND_SWAP_ENDPOINT/submit-tx/status?txHash=…&srcChainKey=…` until terminal (`solved`/`failed`; `solved` = success, was `executed` before a 2026 SODAX SDK rename)
5. **Cross-check journal (soft)** — GET `INTENT_API_ENDPOINT/intent/tx/:txHash` (or `/intent/:intentHash`) for independent on-chain confirmation; bounded by `JOURNAL_CROSSCHECK_TIMEOUT_MS`, never fatal

### CLI flags

- `--sonic-usdt-to-sonic-usdc` (default)
- `--sonic-usdc-to-sonic-usdt`

### Backend APIs

**Submission + primary status — swaps** (`BACKEND_SWAP_ENDPOINT`, default `https://api.sodax.com/v1/swaps`)
- `POST /submit-tx` — submit intent for processing (idempotent on `(txHash, srcChainKey)`; throttled 10/min/IP)
- `GET /submit-tx/status?txHash=…&srcChainKey=…` — pipeline status (`pending → relaying → relayed → posting_execution → posted_execution → solved | failed`) with failure diagnostics. **Primary** poll signal. `solved` is the terminal success state (renamed from `executed` in a 2026 SODAX SDK rename; `executed` now only appears as `result.packetData.status`). A client must not wait for a `solved → executed` transition — there isn't one.

**Cross-check status — intent journal via apps/api** (`INTENT_API_ENDPOINT`, default `https://api.sodax.com/v1/be`, the public gateway prefix for apps/api)
- `GET /intent/tx/:txHash` — instance-precise; use when the broadcast tx is the hub intent tx (Sonic source)
- `GET /intent/:intentHash` — for cross-chain (broadcast tx is on a spoke; `intentHash = sodax.swaps.getIntentHash(intent)`). `findOne` by hash returns the latest instance.
- Lifecycle: 404 (not yet on-chain) → `open: true` → `open: false` (terminal `intent-filled` / `intent-cancelled`); `packetData` carries cross-chain delivery proof. Used as a single soft confirmation after the primary poll terminates.

## Configuration

All runtime config is via `.env` file (loaded with dotenv). Key variables:

- `PRIVATE_KEY` — wallet private key (required)
- `BACKEND_SWAP_ENDPOINT` — swaps base URL (default: `https://api.sodax.com/v1/swaps`)
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

### Timing profiling (`--profile`)

A modifier flag that composes with any hop selection (`--all`, a single `--<hop>`, or `--from`). It runs the **exact same hop sequence** (same order, gas buffers, disabled-chain rewiring, inter-hop arrival waits) but profiles how long each status source takes to report the intent filled.

```bash
pnpm chain-hop:profile                       # --all --profile
pnpm chain-hop -- --sonic-to-base --profile  # single hop, profiled
```

**What changes vs the default flow:** instead of polling the swaps-api to a terminal state *and then* cross-checking the journal (sequential), profile mode **races both concurrently from a shared anchor** — `tBroadcast`, the moment the create-intent tx is broadcast. Both pollers record per-phase transition timestamps relative to that anchor via the new `PollOptions.onPhase` hook (`helpers.ts`), so the two sources are measured from the same `t0`. Console lines are prefixed `[swap-api]` / `[journal]` (in-place rewriting disabled) so concurrent output stays readable.

**Per hop it captures:** `createMs` (SDK build+broadcast), `confirmMs` (receipt wait), `submitMs` (POST /submit-tx), each swaps-api phase (`pending → relaying → relayed → posting_execution → posted_execution → solved`), each journal phase (`first-seen → filled`), and the headline `journalVsSwapDeltaMs = journalFilledMs − swapExecutedMs` (`swapExecutedMs` = time to the terminal `solved` phase).

**Reports** (timestamped, written to cwd): `chain-hop-profile-<ts>.{txt,json,csv}` — human summary with aggregate min/avg/max per source, full machine-readable JSON, and a flat CSV (one row per hop).

**Env vars** (profile-mode only): `PROFILE_POLL_INTERVAL_MS` (default `1500`), `JOURNAL_PROFILE_TIMEOUT_MS` (default `300000`); `POLL_TIMEOUT_MS` defaults to `300000` under `--profile`. The default (non-profile) flow is unchanged.

## Leverage Yield (`leverage-yield.ts`)

Money-path test for the **Leverage Yield API** (`/leverage-yield/*`, in `apps/swaps-api`). The API
had full unit + e2e coverage but had never been exercised with a real transaction; this script is
that empirical validation, tracked in `icon-project/sodax-backend#1029` (a release gate for the
public `/v1/leverage-yield/*` gateway route).

### Contract essentials

- **Base URL comes from `LEVERAGE_YIELD_ENDPOINT` and is a RAW ORIGIN with no `/v1` prefix** — these
  routes are not HAProxy-routed yet, so paths are `/leverage-yield/*` directly on the origin. The
  origin is semi-private: **never hard-code it in a committed file** (this repo is a public reference
  client). `.env.example` carries a placeholder only. The script accepts either the bare origin or
  one already ending in `/leverage-yield`.
- **No SDK leverage module.** `@sodax/sdk` is pinned at `2.0.0-rc.11`; the leverage module needs
  rc.21. It isn't needed — the backend builds every unsigned tx and returns it, so this is plain
  `fetch` + viem signing. **Do not bump the SDK for this**; it would churn the swap flow for nothing.
- All amounts are **decimal strings in smallest units**; `lsoda*` shares are 18 decimals.
- `submit-tx` carries an extra **`operation: "deposit" | "withdraw"`** field (plus the usual
  `txHash` / `srcChainKey` / `walletAddress` / `intent` / `relayData`), and persists it as
  `leverage_deposit` / `leverage_withdraw` — that discriminator is the thing under test.
- Status values match swaps: `pending → relaying → relayed → posting_execution → posted_execution →
  solved | failed`. **Terminal = `solved` or `failed`.** There is no `executed` state (renamed).
- Both status endpoints are the same underlying lookup and neither filters on `operation`, so
  `/swaps/submit-tx/status` would also return a leverage row. Use the leverage path for clarity.

### Per-leg flow

| Leg | Endpoints |
|---|---|
| Deposit (token → shares) | `quote/deposit` → `allowance/check` → `approve` (only if `valid: false`) → `intents/deposit` → sign/broadcast on `srcChainKey` → `submit-tx` → `submit-tx/status` |
| Withdraw (shares → token) | `quote/withdraw` → `intents/withdraw` → sign/broadcast on `srcChainKey` → `submit-tx` → `submit-tx/status` |

`allowance/check`, `approve` and `intents/deposit` all take the **same** body:
`{ vault, srcChainKey, srcAddress, inputToken, inputAmount, minOutputAmount, deadline?, solver?, partnerFee? }`.

### Gotchas (verified against the live backend)

- **There is NO approve step for a withdraw.** The shares sit in the user's derived hub wallet and
  the backend sets `hubWalletSwap: true` internally, bundling the share approval into the same call.
  Approving separately just wastes gas on a no-op.
- **`share-balance` / `max-withdraw` take the derived HUB WALLET as `owner`, not the EOA.** Read it
  from `intent.creator` (equals `relayData.address`) in any create-intent response. Against the EOA
  both endpoints return `0`, which looks like "the deposit didn't land" but isn't.
- **`max-withdraw` returns the RAW on-chain value, NOT dust-trimmed.** Feeding it back verbatim can
  trip the vault's share round-up and revert — subtract a buffer (`LEVERAGE_WITHDRAW_BUFFER_BPS`).
- **`max-withdraw` can be well below `share-balance`** — the leveraged position caps how much is
  withdrawable (observed ~92.4% of the balance on a fresh deposit), so **one withdraw does not fully
  exit a vault**; shares are left behind. The script sizes off `min(max-withdraw, share-balance)`.
- **`vault` must be a valid EVM address** or the request is rejected with a `400`
  (`"vault must be an Ethereum address"`). It used to surface as a misleading `502`; the read-only
  `pnpm leverage:vaults` mode asserts the `400` as a cheap negative test.
- **Leverage withdrawals cannot carry a `partnerFee`** (deposits can) — the SDK's withdraw params
  have no such field, so don't send one. Tracked as `icon-project/sodax-sdks#325`.
- `deadline` defaults to hub block time + **5 minutes** if omitted — short enough to expire during a
  slow settle, so the script always sends an explicit one (`LEVERAGE_DEADLINE_OFFSET_SECONDS`).
- Derive `minOutputAmount` from `quotedAmount` minus your own slippage; never pass a quote verbatim.

### Modes & evidence

`--vaults` (read-only, spends nothing) · `--deposit` · `--withdraw` · `--round-trip`. Each
fund-spending run writes `leverage-yield-proof-<ts>.{txt,json}` (gitignored) containing, per leg, the
source tx hash + `srcChainKey` and the **full final `submit-tx/status` response** — the proof #1029
needs. **The report redacts the origin; console output does not**, so paste the report, not raw logs.

### Not covered: split-tx withdraw from Solana / Bitcoin

#1029 also asks for a withdraw sourced from Solana or Bitcoin. **This repo cannot do it**: there is
no Solana keypair or Bitcoin PSBT signing anywhere, and `solana` is not in `CHAIN_DEFS` (only an
unused `SOLANA_RPC_URL` in `.env`). It needs a non-EVM signer — do not fake it and do not silently
skip it; say so.

## TypeScript

- Target: ES2022, Module: CommonJS, Strict mode enabled
- Runtime: `tsx` (TypeScript execution without compilation step)
- Package manager: `pnpm`

<!-- BEGIN LOCAL DEV RESOURCE COMMANDS -->
## Resource-safe commands for AI agents (shared dev server)

> **Read `~/CLAUDE.md` → "Shared dev-server resource policy" first.** It defines `dev-status`, the go/no-go thresholds (RAM < 8 GiB, swap > 8 GiB, load > 20, another heavy job running) and the `heavy-run` lock. This section only maps that policy onto this repo.
>
> These are **instructions for which commands an interactive AI agent runs on this dev box.** They change nothing for developers or CI, and **no `package.json` or `tsconfig.json` may be edited to enforce them.**

**Package manager:** `pnpm@10.30.3` (single package, `tsx` runtime — no compile/build step).
**Test runner:** **none — no Vitest, no Jest, no test suite.** Verification is `pnpm checkTs` + `pnpm format:check`.
**Existing scripts** (see [Commands](#commands) above — unchanged): `pnpm start`, the `sonic-*` / `hop-*` / `chain-hop` flows, `pnpm cancel`, `pnpm balances`, `pnpm sweep`, `pnpm checkTs`, `pnpm format`, `pnpm format:check`.

### Targeted first — run these directly, no `heavy-run`

This repo is small; typechecking and formatting are cheap:

```bash
pnpm checkTs
pnpm format:check
```

### Repository-wide — `heavy-run`, and tell the user first

Only the install is genuinely expensive here:

```bash
heavy-run timeout 20m pnpm install
```

### ⚠️ Never wrap the on-chain scripts in `timeout`

`pnpm start`, the `hop-*` targets, `chain-hop`, `sweep`, and `cancel` **submit real transactions and then poll for settlement**. Killing one mid-flight does not undo the transaction — it just loses track of an intent that is already on-chain, which is exactly the failure the [Safety guardrails](#safety-guardrails-non-negotiable) exist to prevent. So for these:

- **No `timeout`**, no `heavy-run` (they are network-bound, not CPU-bound — they don't need the lock and shouldn't hold it while polling).
- Run them in the **foreground**, one at a time, and only with the user's explicit go-ahead per the guardrails above.
<!-- END LOCAL DEV RESOURCE COMMANDS -->
