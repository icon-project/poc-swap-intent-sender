import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sonic } from 'viem/chains';
import type { Intent } from '@sodax/sdk';

// ----------------------------------------------------------------------------
// ENV HELPERS
// ----------------------------------------------------------------------------

export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
}

export function normalizePrivateKey(value: string): `0x${string}` {
  return value.startsWith('0x') ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

export function getBigIntEnv(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer string`);
  return BigInt(value);
}

export function getBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

export function getAddressEnv(name: string, fallback: Address): Address {
  const value = process.env[name];
  if (!value) return fallback;
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`);
  return getAddress(value);
}

export function getHexEnv(name: string, fallback: Hex): Hex {
  const value = process.env[name];
  if (!value) return fallback;
  if (!value.startsWith('0x')) throw new Error(`${name} must start with 0x`);
  return value as Hex;
}

// ----------------------------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------------------------

export function unixNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function overwriteLine(text: string): void {
  process.stdout.write(`\r\x1b[K${text}`);
}

export function formatElapsed(startMs: number): string {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

export function addressToBytes(address: Address): Hex {
  return address.toLowerCase() as Hex;
}

// ----------------------------------------------------------------------------
// CONSTANTS & TYPES
// ----------------------------------------------------------------------------

export const TOKENS = {
  USDC: getAddress('0x29219dd400f2Bf60E5a23d13Be72B486D4038894'),
  USDT: getAddress('0x6047828dc181963ba44974801ff68e538da5eaf9'),
} as const;

export const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export type TestCaseName = 'usdt-to-usdc' | 'usdc-to-usdt';

export type TestCase = {
  name: TestCaseName;
  inputToken: Address;
  outputToken: Address;
  decimals: number;
  defaultHumanAmount: string;
};

export const TEST_CASES: Record<TestCaseName, TestCase> = {
  'usdt-to-usdc': {
    name: 'usdt-to-usdc',
    inputToken: TOKENS.USDT,
    outputToken: TOKENS.USDC,
    decimals: 6,
    defaultHumanAmount: '1',
  },
  'usdc-to-usdt': {
    name: 'usdc-to-usdt',
    inputToken: TOKENS.USDC,
    outputToken: TOKENS.USDT,
    decimals: 6,
    defaultHumanAmount: '1',
  },
};

/**
 * Wire shape of `POST /v1/swaps/submit-tx` (swaps v2). The intent's bigint fields are
 * serialized as decimal strings; `srcChain`/`dstChain` are relay chain ids (the SDK's
 * `Intent` already produces these). `srcChainKey` is the source SpokeChainKey (e.g.
 * `sonic`, `0xa4b1.arbitrum`) — renamed from v1's `srcChainId`.
 */
export type SubmitTxPayload = {
  txHash: Hex;
  srcChainKey: string;
  walletAddress: Address;
  intent: {
    intentId: string;
    creator: Address;
    inputToken: Address;
    outputToken: Address;
    inputAmount: string;
    minOutputAmount: string;
    deadline: string;
    allowPartialFill: boolean;
    srcChain: string;
    dstChain: string;
    srcAddress: Hex;
    dstAddress: Hex;
    solver: Address;
    data: Hex;
  };
  relayData: Hex;
};

// ----------------------------------------------------------------------------
// VIEM CLIENT FACTORY
// ----------------------------------------------------------------------------

export function createClients(rpcUrl: string, privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: sonic,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: sonic,
    transport: http(rpcUrl),
  });
  return { account, walletClient, publicClient };
}

// ----------------------------------------------------------------------------
// ERC20 HELPERS
// ----------------------------------------------------------------------------

export async function approveIfNeeded(params: {
  walletClient: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  token: Address;
  spender: Address;
  amount: bigint;
  decimals: number;
}) {
  const { publicClient, walletClient, account, token, spender, amount, decimals } = params;

  const [symbol, balance, allowance] = await Promise.all([
    publicClient
      .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
      .catch(() => '???'),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, spender],
    }),
  ]);

  console.log(`  Token     : ${symbol} (${token})`);
  console.log(
    `  Balance   : ${formatUnits(balance, decimals)} ${symbol} (${balance.toString()} base)`,
  );
  console.log(
    `  Allowance : ${formatUnits(allowance, decimals)} ${symbol} (${allowance.toString()} base)`,
  );
  console.log(
    `  Required  : ${formatUnits(amount, decimals)} ${symbol} (${amount.toString()} base)`,
  );

  if (balance < amount) {
    throw new Error(
      `Insufficient ${symbol} balance: have ${balance.toString()}, need ${amount.toString()}`,
    );
  }

  if (allowance >= amount) {
    console.log(`  Allowance is sufficient`);
    return;
  }

  console.log(`  Allowance insufficient — sending approve tx...`);

  const approveHash = await walletClient.writeContract({
    chain: sonic,
    account,
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });

  console.log(`  Approve tx: ${approveHash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  Approval confirmed in block ${receipt.blockNumber}`);

  await sleep(2000);
}

// ----------------------------------------------------------------------------
// INPUT AMOUNT HELPERS
// ----------------------------------------------------------------------------

export function getInputAmount(testCase: TestCase): bigint {
  const base = process.env.INPUT_AMOUNT;
  if (base && /^\d+$/.test(base)) return BigInt(base);
  const human = process.env.INPUT_AMOUNT_HUMAN || testCase.defaultHumanAmount;
  return parseUnits(human, testCase.decimals);
}

export function getMinOutputAmount(inputAmount: bigint): bigint {
  const explicit = process.env.MIN_OUTPUT_AMOUNT;
  if (explicit && /^\d+$/.test(explicit)) return BigInt(explicit);
  const slippageBps = getBigIntEnv('MIN_OUTPUT_SLIPPAGE_BPS', 500n);
  return (inputAmount * (10_000n - slippageBps)) / 10_000n;
}

// ----------------------------------------------------------------------------
// BACKEND INTERACTION
// ----------------------------------------------------------------------------

/**
 * Build the `POST /v1/swaps/submit-tx` payload from the SDK's `createIntent` result.
 * The SDK `Intent` already carries relay chain ids in `srcChain`/`dstChain` and bigints
 * for the numeric fields, so we just serialize bigints to decimal strings here.
 *
 * `relayData` is the SDK's `RelayExtraData.payload` (a Hex). It is only consumed by the
 * relay for Solana sources; EVM/Sonic flows relay `{ chain_id, tx_hash }` and ignore it,
 * but the endpoint validates it as a non-empty hex string, so we always pass the payload.
 */
export function buildSubmitPayload(
  txHash: Hex,
  walletAddress: Address,
  srcChainKey: string,
  intent: Intent,
  relayData: Hex,
): SubmitTxPayload {
  return {
    txHash,
    srcChainKey,
    walletAddress,
    intent: {
      intentId: intent.intentId.toString(),
      creator: intent.creator,
      inputToken: intent.inputToken,
      outputToken: intent.outputToken,
      inputAmount: intent.inputAmount.toString(),
      minOutputAmount: intent.minOutputAmount.toString(),
      deadline: intent.deadline.toString(),
      allowPartialFill: intent.allowPartialFill,
      srcChain: intent.srcChain.toString(),
      dstChain: intent.dstChain.toString(),
      srcAddress: intent.srcAddress,
      dstAddress: intent.dstAddress,
      solver: intent.solver,
      data: intent.data,
    },
    relayData,
  };
}

export async function submitIntent(payload: SubmitTxPayload, backendBaseUrl: string) {
  const url = `${backendBaseUrl}/submit-tx`;
  console.log(`  POST ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`submit-tx failed with ${response.status}: ${body}`);
  }

  console.log(`  Response: ${response.status} ${body}`);
  return body;
}

/**
 * PRIMARY status poll — the swaps-api v2 `GET /submit-tx/status` route. This is the endpoint
 * under test: keyed exactly by `(txHash, srcChainKey)`, it reports the swaps-api pipeline's
 * own view (`pending → relaying → relayed → posting_execution → executed | failed`) and, on
 * failure, *why* (`failedAtStep` / `failureReason` / `userMessage`), plus the on-chain
 * `intentCancelled` flag. The intent journal (see `crossCheckIntentJournal`) can't surface
 * pipeline-step failures — notably a relay failure means nothing ever lands in the journal.
 */
export async function pollIntentStatus(
  txHash: string,
  backendBaseUrl: string,
  intervalMs = 3000,
  timeoutMs = 120000,
  srcChainKey = 'sonic',
) {
  const url = `${backendBaseUrl}/submit-tx/status?txHash=${txHash}&srcChainKey=${srcChainKey}`;
  console.log(`  GET ${url}`);
  console.log(`  Poll interval: ${intervalMs}ms, timeout: ${timeoutMs}ms`);

  const TERMINAL_STATUSES = new Set(['executed', 'failed']);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  let pollCount = 0;
  const pollStart = Date.now();
  let inPlace = false;

  while (Date.now() < deadline) {
    pollCount++;
    const elapsed = formatElapsed(pollStart);
    const response = await fetch(url);
    const body = (await response.json()) as { success: boolean; data?: Record<string, unknown> };

    if (!response.ok || !body.success || !body.data) {
      overwriteLine(`  Poll #${pollCount} — HTTP ${response.status}, retrying... (${elapsed})`);
      inPlace = true;
      await sleep(intervalMs);
      continue;
    }

    const status = body.data.status as string;

    if (status !== lastStatus || TERMINAL_STATUSES.has(status)) {
      if (inPlace) process.stdout.write('\n');
      inPlace = false;
      console.log(
        `  Poll #${pollCount} — status: ${lastStatus ? `${lastStatus} -> ` : ''}${status} (${elapsed})`,
      );
      lastStatus = status;
    } else {
      overwriteLine(`  Poll #${pollCount} — status: ${status} (${elapsed})`);
      inPlace = true;
    }

    if (TERMINAL_STATUSES.has(status)) {
      if (status === 'executed') {
        console.log(`  Swap executed successfully`);
        const result = body.data.result as Record<string, unknown> | undefined;
        if (result) {
          console.log(`  dstIntentTxHash: ${result.dstIntentTxHash ?? ''}`);
          console.log(`  intent_hash: ${result.intent_hash ?? ''}`);
        }
      } else {
        console.log(`  Swap failed`);
        console.log(`  failedAtStep: ${body.data.failedAtStep ?? ''}`);
        console.log(`  failureReason: ${body.data.failureReason ?? ''}`);
        // v2 status enrichment (swaps-api): user-facing hint + on-chain cancel flag + abandonment.
        if (body.data.userMessage) console.log(`  userMessage: ${body.data.userMessage}`);
        if (body.data.intentCancelled !== undefined)
          console.log(`  intentCancelled: ${body.data.intentCancelled}`);
        if (body.data.abandonedAt) console.log(`  abandonedAt: ${body.data.abandonedAt}`);
      }

      console.log(`\n  Full submit-tx/status response:`);
      console.dir(body, { depth: null });
      return body;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Polling timed out after ${timeoutMs}ms — last status: ${lastStatus}`);
}

/** Subset of the apps/api intent-journal response we read while polling. */
type IntentJournalResponse = {
  intentHash: string;
  txHash: string;
  open: boolean;
  events?: Array<{ eventType: string; txHash: string; blockNumber?: number }>;
  packetData?: { status: string; dst_tx_hash: string };
};

/**
 * How to look the intent up in the journal:
 *  - `{ txHash }`     → `GET /intent/tx/:txHash` — instance-precise, but only matches
 *    when the broadcast tx IS the hub (Sonic) intent tx (i.e. Sonic-source swaps).
 *  - `{ intentHash }` → `GET /intent/:intentHash` — use for cross-chain swaps where the
 *    broadcast tx is on a spoke chain (the journal is keyed by the hub tx). `findOne`
 *    by hash, so it returns the latest instance — fine for a single fresh swap.
 */
export type IntentJournalLookup = { txHash: string } | { intentHash: string };

/**
 * Poll the intent journal via apps/api as an *independent on-chain confirmation* of the swap
 * (complements `pollIntentStatus`, which is the swaps-api's own self-report). The journal is
 * written by the aggregator/transformator from on-chain INTENT_* events and is identical
 * across deployments, so it is ground truth for "did the fill/cancel actually land on-chain".
 *
 * Lifecycle: 404 until the aggregator observes `INTENT_CREATED` → `open: true` (created,
 * awaiting fill/cancel) → `open: false` once a terminal `intent-filled` / `intent-cancelled`
 * event lands. `packetData` carries the cross-chain delivery proof when present.
 */
export async function pollIntentJournal(
  apiBaseUrl: string,
  lookup: IntentJournalLookup,
  intervalMs = 3000,
  timeoutMs = 180000,
) {
  const path = 'txHash' in lookup ? `intent/tx/${lookup.txHash}` : `intent/${lookup.intentHash}`;
  const url = `${apiBaseUrl}/${path}`;
  console.log(`  GET ${url}`);
  console.log(`  Poll interval: ${intervalMs}ms, timeout: ${timeoutMs}ms`);

  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  let lastState = '';
  let inPlace = false;
  const pollStart = Date.now();

  while (Date.now() < deadline) {
    pollCount++;
    const elapsed = formatElapsed(pollStart);
    const response = await fetch(url);

    // 404 until the aggregator observes INTENT_CREATED on-chain and the transformator
    // writes the journal row — expected for the first few polls after submission.
    if (response.status === 404) {
      overwriteLine(`  Poll #${pollCount} — not in journal yet (404), waiting... (${elapsed})`);
      inPlace = true;
      await sleep(intervalMs);
      continue;
    }

    if (!response.ok) {
      overwriteLine(`  Poll #${pollCount} — HTTP ${response.status}, retrying... (${elapsed})`);
      inPlace = true;
      await sleep(intervalMs);
      continue;
    }

    const journal = (await response.json()) as IntentJournalResponse;
    const state = journal.open ? 'open' : 'closed';

    if (state !== lastState) {
      if (inPlace) process.stdout.write('\n');
      inPlace = false;
      console.log(
        `  Poll #${pollCount} — journal: ${lastState ? `${lastState} -> ` : ''}${state} (${elapsed})`,
      );
      lastState = state;
    } else {
      overwriteLine(`  Poll #${pollCount} — journal: ${state} (${elapsed})`);
      inPlace = true;
    }

    // `open: false` means a terminal INTENT_FILLED / INTENT_CANCELLED has been observed.
    if (!journal.open) {
      if (inPlace) process.stdout.write('\n');
      const events = journal.events ?? [];
      const filled = events.find((e) => e.eventType === 'intent-filled');
      const cancelled = events.find((e) => e.eventType === 'intent-cancelled');
      if (filled) {
        console.log(`  Intent FILLED`);
        console.log(`  fill txHash : ${filled.txHash}`);
      } else if (cancelled) {
        console.log(`  Intent CANCELLED`);
        console.log(`  cancel txHash: ${cancelled.txHash}`);
      } else {
        console.log(`  Intent closed (no fill/cancel event present)`);
      }
      if (journal.packetData) {
        console.log(`  packet status: ${journal.packetData.status}`);
        console.log(`  dst tx hash  : ${journal.packetData.dst_tx_hash}`);
      }
      console.log(`\n  Journal entry:`);
      console.dir(journal, { depth: null });
      return journal;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Polling timed out after ${timeoutMs}ms — last journal state: ${lastState || 'not found'}`,
  );
}

/**
 * Soft, bounded journal confirmation run AFTER the primary `pollIntentStatus` has reached a
 * terminal state. The aggregator may lag the swaps-api by a few blocks, so this never fails
 * the run: a timeout (journal not yet caught up) is logged as inconclusive, not thrown.
 */
export async function crossCheckIntentJournal(
  apiBaseUrl: string,
  lookup: IntentJournalLookup,
  intervalMs = 3000,
  timeoutMs = 90000,
): Promise<void> {
  console.log(`  Independent on-chain confirmation via the intent journal:`);
  try {
    await pollIntentJournal(apiBaseUrl, lookup, intervalMs, timeoutMs);
  } catch (err) {
    console.log(
      `  Journal cross-check inconclusive (aggregator may still be catching up): ${(err as Error).message}`,
    );
  }
}

// ----------------------------------------------------------------------------
// INTENT LOOKUP (for `pnpm cancel`)
// ----------------------------------------------------------------------------

/** Wire shape of the `intent` sub-object in an apps/api journal entry (bigints as strings). */
export type JournalIntent = {
  intentId: string;
  creator: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  minOutputAmount: string;
  deadline: string;
  allowPartialFill: boolean;
  srcChain: number;
  dstChain: number;
  srcAddress: string;
  dstAddress: string;
  solver: string;
  data: string;
};

/** A journal entry as returned by `/intent/user/:addr` and `/intent/:hash`. */
export type JournalEntry = {
  intentHash: string;
  txHash: string;
  open: boolean;
  intent: JournalIntent;
  events?: Array<{ eventType: string; txHash: string }>;
};

/** Rehydrate the SDK `Intent` (bigints) from the journal's wire shape. The struct is decoded
 *  from the on-chain `IntentCreated` event, so it round-trips to the same intentHash — exactly
 *  what `cancelIntent` needs. `srcChain`/`dstChain` are relay chain ids (bigint). */
export function journalIntentToSdkIntent(j: JournalIntent): Intent {
  return {
    intentId: BigInt(j.intentId),
    creator: j.creator as Address,
    inputToken: j.inputToken as Address,
    outputToken: j.outputToken as Address,
    inputAmount: BigInt(j.inputAmount),
    minOutputAmount: BigInt(j.minOutputAmount),
    deadline: BigInt(j.deadline),
    allowPartialFill: j.allowPartialFill,
    srcChain: BigInt(j.srcChain) as Intent['srcChain'],
    dstChain: BigInt(j.dstChain) as Intent['dstChain'],
    srcAddress: j.srcAddress as Hex,
    dstAddress: j.dstAddress as Hex,
    solver: j.solver as Address,
    data: j.data as Hex,
  };
}

/**
 * Resolve an `intentId` to its journal entry by scanning the wallet's recent intents
 * (`GET /intent/user/:addr`). The journal has no by-id route, so we filter the user's history.
 * Prefers an `open` instance (the cancellable one). Returns null if not found in the latest page.
 *
 * NOTE: only the most recent ~100 intents for the wallet are scanned — sufficient for a PoC
 * test wallet; a busier wallet would need pagination via `offset`.
 */
export async function findIntentById(
  apiBaseUrl: string,
  userAddress: string,
  intentId: string,
): Promise<JournalEntry | null> {
  const url = `${apiBaseUrl}/intent/user/${userAddress}?limit=100`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`intent history fetch failed: HTTP ${response.status} (${url})`);
  }
  const body = (await response.json()) as { items?: JournalEntry[] };
  const matches = (body.items ?? []).filter((i) => i.intent?.intentId === intentId);
  if (matches.length === 0) return null;
  return matches.find((m) => m.open) ?? matches[0];
}
