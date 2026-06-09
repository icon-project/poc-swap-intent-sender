# Sending Swap Intents to SODAX (Swaps v2)

A practical guide for a bot running on your own infra to submit swap intents to the
SODAX **swaps v2** backend. The flow is the same for a same-chain swap (e.g. USDT→USDC
on Sonic) and a cross-chain hop (e.g. USDT on Sonic → native ETH on Base): build and
broadcast the intent with `@sodax/sdk`, then hand the tx to the swaps API for async
execution and poll for the result.

## TL;DR

```
[your bot] --(1) approve ERC20----------------------> source chain
[your bot] --(2) sodax.swaps.createIntent(...)-------> source chain  (broadcasts the tx)
[your bot] --(3) POST  /v1/swaps/submit-tx----------> swaps API      (hand off tx + intent)
[your bot] --(4) GET   /v1/swaps/submit-tx/status---> swaps API      (poll until terminal)
```

You never hand-craft the intent or the relay data — the SDK builds them (correct relay
chain ids, deadline encoding, relay payload). The swaps API does the cross-chain
relaying and execution for you.

## 0. Prerequisites

- `@sodax/sdk` **v2** (`2.0.0-rc.11`+) and `@sodax/types`.
- An EVM wallet (private key) funded with the input token + gas on the **source** chain.
- An `IEvmWalletProvider` the SDK can sign with. This PoC's `ViemWalletProvider`
  (`sdk-helpers.ts`) is a drop-in reference implementation over viem.
- Base URL of the swaps API: **`https://canary-api.sodax.com/v1/swaps`**
  (canary). Configurable via `BACKEND_SWAP_ENDPOINT`.

> The old v1 base path `/v1/bes/swaps` is retired (→ 404). Use `/v1/swaps`.

## 1. Approve the ERC20 (skip for native-token inputs)

The intent contract pulls the input token from your wallet, so it needs an allowance.
The spender is the SDK's intents contract:

```ts
import { getSolverConfig } from '@sodax/types';
const intentsContract = getSolverConfig().intentsContract; // spender to approve
// approve(intentsContract, inputAmount) on the input ERC20 if allowance < inputAmount
```

For a native-token input (`inputToken: 0x0000…0000`) there is no approval — the value
is sent with the create-intent tx.

## 2. Build + broadcast the intent (SDK)

```ts
import { Sodax, type CreateIntentParams } from '@sodax/sdk';

const sodax = new Sodax();

const params: CreateIntentParams = {
  inputToken,                       // address on the source chain (0x0 for native)
  outputToken,                      // address on the destination chain (0x0 for native)
  inputAmount,                      // bigint, base units
  minOutputAmount,                  // bigint, base units (slippage floor; 0 = no floor)
  deadline,                         // bigint, unix seconds
  allowPartialFill: false,
  srcChainKey: 'sonic',             // SpokeChainKey of the source chain
  dstChainKey: 'sonic',             // SpokeChainKey of the destination chain
  srcAddress: wallet.toLowerCase(), // refund/sender on source
  dstAddress: wallet.toLowerCase(), // recipient on destination
  solver: '0x0000000000000000000000000000000000000000', // 0x0 = any solver (open)
  data: '0x',
};

const result = await sodax.swaps.createIntent({ params, walletProvider });
if (!result.ok) throw new Error(JSON.stringify(result.error));

const { tx: txHash, intent, relayData } = result.value;
// `txHash` is the broadcast create-intent tx on the SOURCE chain.
// Wait for the source-chain receipt before submitting.
```

`SpokeChainKey` values are like `sonic`, `0x2105.base`, `0xa.optimism`,
`0xa4b1.arbitrum`, `0x89.polygon`, `ethereum`, … (one per supported chain).

## 3. Submit to the swaps API — `POST /v1/swaps/submit-tx`

Serialize the SDK `intent` (bigints → decimal strings) and post it with the tx hash.
`relayData` is the SDK's `relayData.payload` (hex).

```ts
const payload = {
  txHash,                       // 0x… broadcast tx on the source chain
  srcChainKey: 'sonic',         // SpokeChainKey of the source chain
  walletAddress: wallet,        // 0x… your wallet
  intent: {
    intentId:        intent.intentId.toString(),
    creator:         intent.creator,
    inputToken:      intent.inputToken,
    outputToken:     intent.outputToken,
    inputAmount:     intent.inputAmount.toString(),
    minOutputAmount: intent.minOutputAmount.toString(),
    deadline:        intent.deadline.toString(),
    allowPartialFill: intent.allowPartialFill,
    srcChain:        intent.srcChain.toString(),  // relay chain id (SDK-filled)
    dstChain:        intent.dstChain.toString(),  // relay chain id (SDK-filled)
    srcAddress:      intent.srcAddress,
    dstAddress:      intent.dstAddress,
    solver:          intent.solver,
    data:            intent.data,
  },
  relayData: relayData.payload,   // hex; required, validated as non-empty
};

const res = await fetch(`${BASE}/submit-tx`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
// 200 => { "success": true, "data": { "message": "...", "status": "inserted" } }
```

Notes for a bot:
- **Idempotent** on `(txHash, srcChainKey)` — safe to retry the submit.
- **Rate limited** to ~**10 requests/min/IP**. Throttle if you run many intents.
- `relayData.payload` is only consumed for Solana sources; EVM/Sonic flows relay
  `{ chain_id, tx_hash }` and ignore it, but the endpoint still requires it to be
  present and non-empty — always pass it.

## 4. Poll status — `GET /v1/swaps/submit-tx/status`

Keyed exactly by `(txHash, srcChainKey)`:

```ts
const url = `${BASE}/submit-tx/status?txHash=${txHash}&srcChainKey=${srcChainKey}`;
// poll every ~3s until status is terminal
```

Pipeline lifecycle:

```
pending → relaying → relayed → posting_execution → executed | failed
```

**Success** (`status: "executed"`):
```json
{ "success": true, "data": {
  "txHash": "0x…", "srcChainKey": "sonic", "status": "executed",
  "processingAttempts": 1,
  "result": {
    "dstIntentTxHash": "0x…",   // fill tx on the destination side
    "intent_hash": "0x…",
    "packetData": { "status": "executed", "dst_tx_hash": "0x…", … }  // cross-chain only
  }
} }
```

**Failure** (`status: "failed"`) — the data carries diagnostics:
- `failedAtStep` — which pipeline step failed
- `failureReason` — machine reason
- `userMessage` — human-readable hint
- `intentCancelled` — on-chain cancel flag
- `abandonedAt` — set if the pipeline gave up

Treat **`executed`** and **`failed`** as terminal; everything else means keep polling.
A relay-level failure means nothing ever lands on-chain, so `submit-tx/status` is your
primary (and sometimes only) signal — don't rely on the journal alone.

## 5. (Optional) Independent on-chain confirmation — intent journal

For belt-and-suspenders confirmation that the fill actually landed on-chain, query the
on-chain-derived intent journal (apps/api, default
`https://apiv1-1.coolify.iconblockchain.xyz`). It's independent of the swaps API's
self-report.

- **Sonic-source** (broadcast tx IS the hub intent tx): `GET /intent/tx/:txHash`
- **Cross-chain** (broadcast tx is on a spoke): `GET /intent/:intentHash`, where
  `intentHash = sodax.swaps.getIntentHash(intent)`

Lifecycle: `404` (not yet observed) → `open: true` (created) → `open: false`
(terminal `intent-filled` / `intent-cancelled`). `packetData` carries cross-chain
delivery proof. Use it as a *soft* check — aggregator lag can make it trail the swaps
API, so never let it fail an otherwise-executed run.

## 6. Cancelling an open intent

If an intent is still open (not yet filled), cancel it with the SDK:
`sodax.swaps.cancelIntent(...)` (see `cancel.ts`).

## Operational checklist for a bot

- [ ] Pre-flight: input balance ≥ `inputAmount` and gas on the source chain.
- [ ] Read balances from a **fresh, in-sync RPC**. A lagging node returns stale
      balances → false "insufficient balance". Prefer a node you trust over a shared
      pool; verify `eth_blockNumber` is at the chain tip on startup.
- [ ] Approve once (or use a large allowance) to avoid an approval tx per intent.
- [ ] After `createIntent`, wait for the **source-chain receipt** before `submit-tx`.
- [ ] Respect the **10 req/min/IP** limit; back off on `429`.
- [ ] Retry `submit-tx` freely — it's idempotent on `(txHash, srcChainKey)`.
- [ ] Poll `submit-tx/status` until `executed`/`failed`; log `failedAtStep` /
      `failureReason` / `userMessage` on failure.
- [ ] For cross-chain, expect hub→spoke delivery to lag the `executed` status by
      minutes; if your next action depends on funds arriving on the destination, poll
      the destination balance with a generous timeout (5–15 min) rather than assuming
      instant settlement.

## Reference implementation

| Concern | File |
|---|---|
| Same-chain end-to-end flow | `main.ts` |
| Submit payload + submit/poll helpers | `helpers.ts` (`buildSubmitPayload`, `submitIntent`, `pollIntentStatus`) |
| Wallet provider + chain registry | `sdk-helpers.ts` (`ViemWalletProvider`) |
| Cross-chain hops | `chain-hop.ts` |
| Cancel an open intent | `cancel.ts` |
