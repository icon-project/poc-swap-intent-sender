import { writeFileSync } from 'fs';
import dotenv from 'dotenv';
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { EvmRawTransaction } from '@sodax/sdk';
import {
  erc20Abi,
  formatElapsed,
  getBigIntEnv,
  getRequiredEnv,
  normalizePrivateKey,
  pollIntentStatus,
  sleep,
  unixNow,
} from './helpers';
import {
  CHAIN_DEFS,
  type ChainDef,
  NATIVE,
  SONIC_USDT,
  ViemWalletProvider,
  getRpcUrl,
} from './sdk-helpers';

dotenv.config();

// ----------------------------------------------------------------------------
// WHAT THIS IS
// ----------------------------------------------------------------------------
//
// Money-path test for the Leverage Yield API (`/leverage-yield/*` in apps/swaps-api).
// The API has unit + e2e coverage but had never been exercised with a real transaction;
// this script closes that gap and prints the evidence icon-project/sodax-backend#1029
// asks for.
//
// Two legs, both signed with the wallet this repo already uses:
//   Leg 1  deposit  — any spoke token  → lsoda* vault shares
//   Leg 2  withdraw — lsoda* shares    → any token (no approve step; hub-wallet path)
//
// Deliberately NOT using the SDK's leverage module: `@sodax/sdk` is pinned at
// 2.0.0-rc.11 here and the leverage module landed in rc.21. It isn't needed —
// the backend builds every unsigned tx and hands it back, so this is plain
// `fetch` + viem signing. Bumping the SDK would churn the swap flow for nothing.
//
// The backend under test is NOT yet routed by the public gateway (that's what #1029
// gates), so its base URL comes from `LEVERAGE_YIELD_ENDPOINT` and is never written
// into a committed file. See `.env.example`.

// ----------------------------------------------------------------------------
// ENDPOINT RESOLUTION
// ----------------------------------------------------------------------------

const ROUTE_PREFIX = '/leverage-yield';

/**
 * Base URL for the leverage routes, from `LEVERAGE_YIELD_ENDPOINT`.
 *
 * Unlike `BACKEND_SWAP_ENDPOINT` (the public gateway's `/v1/swaps` prefix), these routes
 * live at `/leverage-yield/*` directly on the origin — there is no `/v1` in front, because
 * HAProxy does not route them yet. Accepts either the bare origin or one that already ends
 * in `/leverage-yield`, so both spellings in `.env` work.
 */
function getLeverageBaseUrl(): string {
  const raw = getRequiredEnv('LEVERAGE_YIELD_ENDPOINT').trim().replace(/\/+$/, '');
  const origin = raw.endsWith(ROUTE_PREFIX) ? raw.slice(0, -ROUTE_PREFIX.length) : raw;
  return `${origin}${ROUTE_PREFIX}`;
}

/**
 * Strip the origin out of a URL for anything that gets saved to disk or pasted into an
 * issue. The console keeps full URLs (local debugging), the proof report does not — the
 * origin is semi-private until the gateway route opens.
 */
function redactOrigin(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '<LEVERAGE_YIELD_ENDPOINT>');
}

// ----------------------------------------------------------------------------
// WIRE TYPES
// ----------------------------------------------------------------------------

type Vault = {
  name: string;
  vault: Address;
  asset: Address;
  borrowToken: Address;
  lsdSource?: { poolId: string; fallbackAprPct: number; label: string };
};

type QuoteResponse = { quotedAmount: string };

/** An unsigned tx built by the backend — fed straight to the wallet provider. */
type UnsignedTx = { from?: Address; to: Address; data: Hex; value?: string };

/**
 * The intent as the backend serializes it (bigints already decimal strings). It goes back
 * to `submit-tx` verbatim — no rehydration, unlike the SDK-built swap path.
 */
type BackendIntent = Record<string, unknown> & { creator: Address; intentId: string };

type CreateIntentResponse = {
  tx: UnsignedTx;
  intent: BackendIntent;
  relayData: { address: Address; payload: Hex };
};

type SubmitResponse = {
  success: boolean;
  data?: { message?: string; status?: 'inserted' | 'duplicate' };
};

type StatusResponse = { success: boolean; data?: Record<string, unknown> };

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

/** Raw POST that does not throw on a non-2xx — used by the negative test. */
async function postRaw(url: string, body: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------

type Config = {
  baseUrl: string;
  srcChain: ChainDef;
  dstChainKey: string;
  privateKey: Hex;
  walletAddress: Address;
  vaultSelector: { address?: Address; name?: string };
  inputToken: Address;
  outputToken: Address;
  slippageBps: bigint;
  withdrawBufferBps: bigint;
  deadlineOffsetSeconds: bigint;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  explicitInputAmount?: string;
  explicitWithdrawShares?: string;
  inputAmountHuman?: string;
};

function resolveChainDef(envVar: string, fallbackKey: string): ChainDef {
  const key = (process.env[envVar] || fallbackKey).toLowerCase();
  const def = CHAIN_DEFS[key];
  if (!def) {
    throw new Error(
      `${envVar}='${key}' is not a known chain. Valid keys: ${Object.keys(CHAIN_DEFS).join(', ')}`,
    );
  }
  return def;
}

function getTokenEnv(name: string, fallback: Address): Address {
  const value = process.env[name];
  if (!value) return fallback;
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`);
  return getAddress(value);
}

function loadConfig(): Config {
  const privateKey = normalizePrivateKey(getRequiredEnv('PRIVATE_KEY'));
  const account = privateKeyToAccount(privateKey);
  const srcChain = resolveChainDef('LEVERAGE_SRC_CHAIN_KEY', 'sonic');
  const dstChainKey = (process.env.LEVERAGE_DST_CHAIN_KEY || srcChain.chainKey).toLowerCase();

  // Default input: USDT on Sonic (what this wallet holds), native gas token elsewhere —
  // the same convention `chain-hop.ts` uses for spokes.
  const defaultToken = srcChain.chainKey === 'sonic' ? getAddress(SONIC_USDT) : getAddress(NATIVE);
  const inputToken = getTokenEnv('LEVERAGE_INPUT_TOKEN', defaultToken);

  return {
    baseUrl: getLeverageBaseUrl(),
    srcChain,
    dstChainKey,
    privateKey,
    walletAddress: account.address,
    vaultSelector: {
      address: process.env.LEVERAGE_VAULT ? getTokenEnv('LEVERAGE_VAULT', defaultToken) : undefined,
      name: process.env.LEVERAGE_VAULT_NAME,
    },
    inputToken,
    // Withdraw back into the deposit token by default, i.e. a round trip.
    outputToken: getTokenEnv('LEVERAGE_OUTPUT_TOKEN', inputToken),
    slippageBps: getBigIntEnv('LEVERAGE_SLIPPAGE_BPS', 500n),
    withdrawBufferBps: getBigIntEnv('LEVERAGE_WITHDRAW_BUFFER_BPS', 50n),
    deadlineOffsetSeconds: getBigIntEnv('LEVERAGE_DEADLINE_OFFSET_SECONDS', 1800n),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? '3000'),
    // Vault ops go through the same drainer as swaps but do more on-chain work, so the
    // default budget is more generous than the swap flow's 120s.
    pollTimeoutMs: Number(process.env.LEVERAGE_POLL_TIMEOUT_MS ?? '300000'),
    explicitInputAmount: process.env.LEVERAGE_INPUT_AMOUNT,
    explicitWithdrawShares: process.env.LEVERAGE_WITHDRAW_SHARES,
    inputAmountHuman: process.env.LEVERAGE_INPUT_AMOUNT_HUMAN,
  };
}

// ----------------------------------------------------------------------------
// VAULT DISCOVERY
// ----------------------------------------------------------------------------

async function fetchVaults(cfg: Config): Promise<Vault[]> {
  return getJson<Vault[]>(`${cfg.baseUrl}/vaults`);
}

/**
 * Pick the vault to test: `LEVERAGE_VAULT` (address) wins, then `LEVERAGE_VAULT_NAME`,
 * else the first vault the backend lists. No vault address is hard-coded here — they all
 * come from `GET /vaults`.
 */
function selectVault(vaults: Vault[], cfg: Config): Vault {
  if (vaults.length === 0) throw new Error('GET /vaults returned no vaults');

  if (cfg.vaultSelector.address) {
    const wanted = cfg.vaultSelector.address.toLowerCase();
    const found = vaults.find((v) => v.vault.toLowerCase() === wanted);
    if (!found)
      throw new Error(`LEVERAGE_VAULT ${cfg.vaultSelector.address} is not a listed vault`);
    return found;
  }
  if (cfg.vaultSelector.name) {
    const wanted = cfg.vaultSelector.name.toLowerCase();
    const found = vaults.find((v) => v.name.toLowerCase() === wanted);
    if (!found) {
      throw new Error(
        `LEVERAGE_VAULT_NAME '${cfg.vaultSelector.name}' not found. Available: ${vaults.map((v) => v.name).join(', ')}`,
      );
    }
    return found;
  }
  return vaults[0];
}

// ----------------------------------------------------------------------------
// TOKEN HELPERS
// ----------------------------------------------------------------------------

function isNative(token: Address): boolean {
  return token.toLowerCase() === NATIVE.toLowerCase();
}

function spokePublicClient(def: ChainDef) {
  return createPublicClient({ chain: def.viemChain, transport: http(getRpcUrl(def)) });
}

type TokenInfo = { symbol: string; decimals: number; balance: bigint };

async function readTokenInfo(cfg: Config, token: Address): Promise<TokenInfo> {
  const client = spokePublicClient(cfg.srcChain);
  if (isNative(token)) {
    return {
      symbol: cfg.srcChain.nativeSymbol,
      decimals: 18,
      balance: await client.getBalance({ address: cfg.walletAddress }),
    };
  }
  const [symbol, decimals, balance] = await Promise.all([
    client
      .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
      .catch(() => '???'),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [cfg.walletAddress],
    }),
  ]);
  return { symbol, decimals: Number(decimals), balance };
}

/** Resolve the deposit amount in base units. `LEVERAGE_INPUT_AMOUNT` (raw) wins. */
function resolveInputAmount(cfg: Config, token: TokenInfo): bigint {
  if (cfg.explicitInputAmount) {
    if (!/^\d+$/.test(cfg.explicitInputAmount)) {
      throw new Error('LEVERAGE_INPUT_AMOUNT must be an integer string (base units)');
    }
    return BigInt(cfg.explicitInputAmount);
  }
  if (cfg.inputAmountHuman) return parseUnits(cfg.inputAmountHuman, token.decimals);
  if (isNative(cfg.inputToken)) {
    // "1" would mean 1 whole ETH/AVAX/BNB. Refuse to guess for a native deposit.
    throw new Error(
      'Set LEVERAGE_INPUT_AMOUNT_HUMAN (or LEVERAGE_INPUT_AMOUNT) explicitly for a native-token deposit',
    );
  }
  return parseUnits('1', token.decimals);
}

/** minOutput = quote − slippage. Never pass a quote through verbatim. */
function applySlippage(quoted: bigint, bps: bigint): bigint {
  return (quoted * (10_000n - bps)) / 10_000n;
}

// ----------------------------------------------------------------------------
// BROADCAST
// ----------------------------------------------------------------------------

/**
 * Sign and broadcast one of the backend's unsigned txs on the source spoke, then wait for
 * the receipt. `ViemWalletProvider` is reused for its EIP-1559 fallback (some spoke RPCs
 * mis-estimate fees). A reverted tx throws here so we never submit it to the backend.
 */
async function broadcast(cfg: Config, tx: UnsignedTx, label: string): Promise<Hex> {
  const provider = new ViemWalletProvider(
    cfg.privateKey,
    cfg.srcChain.viemChain,
    getRpcUrl(cfg.srcChain),
  );
  console.log(`  ${label}: to=${tx.to} value=${tx.value ?? '0'} dataLen=${tx.data.length}`);

  const hash = (await provider.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
  } as unknown as EvmRawTransaction)) as Hex;
  console.log(`  ${label} tx: ${hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await spokePublicClient(cfg.srcChain).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label} tx ${hash} reverted on-chain (block ${receipt.blockNumber})`);
  }
  console.log(`  Confirmed in block ${receipt.blockNumber} | gas used: ${receipt.gasUsed}`);
  return hash;
}

// ----------------------------------------------------------------------------
// SUBMIT + POLL
// ----------------------------------------------------------------------------

type Operation = 'deposit' | 'withdraw';

/** `operation` as the backend persists it — the discriminator #1029 is verifying. */
const EXPECTED_STATUS_OPERATION: Record<Operation, string> = {
  deposit: 'leverage_deposit',
  withdraw: 'leverage_withdraw',
};

/**
 * POST /leverage-yield/submit-tx.
 *
 * `intent` and `relayData` go back exactly as the create-intent call returned them, plus the
 * `operation` discriminator and `walletAddress` (easy to forget, and required).
 *
 * `relayData` shape: the swaps `submit-tx` validates it as a non-empty hex string, so we send
 * `relayData.payload` first. If this endpoint's DTO instead wants the whole object, the 400
 * says so and we retry once with the object — the tx is already on-chain at this point, so
 * failing the submit outright would orphan a paid-for intent.
 */
async function submitLeverageTx(
  cfg: Config,
  args: {
    txHash: Hex;
    intent: BackendIntent;
    relayData: CreateIntentResponse['relayData'];
    operation: Operation;
  },
): Promise<{ response: SubmitResponse; relayDataForm: 'payload' | 'object' }> {
  const url = `${cfg.baseUrl}/submit-tx`;
  const base = {
    txHash: args.txHash,
    srcChainKey: cfg.srcChain.chainKey,
    walletAddress: cfg.walletAddress,
    intent: args.intent,
    operation: args.operation,
  };
  console.log(`  POST ${url} (operation: ${args.operation})`);

  try {
    const response = await postJson<SubmitResponse>(url, {
      ...base,
      relayData: args.relayData.payload,
    });
    console.log(`  Response: ${JSON.stringify(response)}`);
    return { response, relayDataForm: 'payload' };
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes('relayData') || !message.includes('400')) throw err;
    console.log(`  submit-tx rejected relayData-as-hex; retrying with the full object`);
    const response = await postJson<SubmitResponse>(url, { ...base, relayData: args.relayData });
    console.log(`  Response: ${JSON.stringify(response)}`);
    return { response, relayDataForm: 'object' };
  }
}

// ----------------------------------------------------------------------------
// EVIDENCE
// ----------------------------------------------------------------------------

type LegEvidence = {
  leg: Operation;
  vaultName: string;
  vaultAddress: Address;
  srcChainKey: string;
  dstChainKey?: string;
  hubWallet: Address;
  walletAddress: Address;
  inputToken: Address;
  inputAmount: string;
  quotedAmount: string;
  minOutputAmount: string;
  deadline: string;
  approveTxHash?: Hex;
  txHash: Hex;
  statusUrl: string;
  submitResponse: SubmitResponse;
  relayDataForm: 'payload' | 'object';
  finalStatus: StatusResponse;
  statusOperation: string;
  statusValue: string;
  expectedOperation: string;
  proofOk: boolean;
  sharesAfter?: string;
  elapsedMs: number;
};

/** Assert the two things #1029 is actually testing, and say which one failed. */
function assessProof(status: StatusResponse, operation: Operation) {
  const data = status.data ?? {};
  const statusValue = String(data.status ?? '');
  const statusOperation = String(data.operation ?? '');
  const expectedOperation = EXPECTED_STATUS_OPERATION[operation];
  const proofOk = statusValue === 'solved' && statusOperation === expectedOperation;

  console.log(`\n  Proof check:`);
  console.log(
    `    operation : ${statusOperation || '(missing)'} ${statusOperation === expectedOperation ? 'OK' : `EXPECTED ${expectedOperation}`}`,
  );
  console.log(
    `    status    : ${statusValue || '(missing)'} ${statusValue === 'solved' ? 'OK' : 'EXPECTED solved'}`,
  );
  return { statusValue, statusOperation, expectedOperation, proofOk };
}

// ----------------------------------------------------------------------------
// LEG 1 — DEPOSIT (spoke token -> lsoda* shares)
// ----------------------------------------------------------------------------

async function runDeposit(cfg: Config, vault: Vault): Promise<LegEvidence> {
  const startMs = Date.now();
  console.log(`\n${'='.repeat(78)}`);
  console.log(`LEG 1 — leverage DEPOSIT into ${vault.name} (${vault.vault})`);
  console.log(`${'='.repeat(78)}`);

  // Step 1: what are we spending, and do we have it?
  console.log(`\n[1/6] Source token & balance on ${cfg.srcChain.name}`);
  const token = await readTokenInfo(cfg, cfg.inputToken);
  const inputAmount = resolveInputAmount(cfg, token);
  console.log(`  Token   : ${token.symbol} (${cfg.inputToken})`);
  console.log(
    `  Balance : ${formatUnits(token.balance, token.decimals)} ${token.symbol} (${token.balance} base)`,
  );
  console.log(
    `  Deposit : ${formatUnits(inputAmount, token.decimals)} ${token.symbol} (${inputAmount} base)`,
  );
  if (token.balance < inputAmount) {
    throw new Error(`Insufficient ${token.symbol}: have ${token.balance}, need ${inputAmount}`);
  }

  // Step 2: quote, then take our own slippage off it.
  console.log(`\n[2/6] Quote deposit`);
  const quote = await postJson<QuoteResponse>(`${cfg.baseUrl}/quote/deposit`, {
    vault: vault.vault,
    tokenSrc: cfg.inputToken,
    tokenSrcChainKey: cfg.srcChain.chainKey,
    amount: inputAmount.toString(),
    quoteType: 'exact_input',
  });
  const minOutputAmount = applySlippage(BigInt(quote.quotedAmount), cfg.slippageBps);
  console.log(`  quotedAmount    : ${quote.quotedAmount} (${vault.name} shares, 18dp)`);
  console.log(`  minOutputAmount : ${minOutputAmount} (quote − ${cfg.slippageBps}bps)`);

  const deadline = unixNow() + cfg.deadlineOffsetSeconds;
  const intentBody = {
    vault: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    srcAddress: cfg.walletAddress,
    inputToken: cfg.inputToken,
    inputAmount: inputAmount.toString(),
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
  };

  // Step 3: allowance/check + approve — the backend's own endpoints, so this run exercises
  // them too rather than approving locally via `approveIfNeeded`.
  console.log(`\n[3/6] Allowance check`);
  let approveTxHash: Hex | undefined;
  if (isNative(cfg.inputToken)) {
    console.log(`  Native input token — no ERC20 approval needed`);
  } else {
    const allowance = await postJson<{ valid: boolean }>(
      `${cfg.baseUrl}/allowance/check`,
      intentBody,
    );
    console.log(`  valid: ${allowance.valid}`);
    if (allowance.valid) {
      console.log(`  Allowance sufficient — skipping approve`);
    } else {
      const { tx } = await postJson<{ tx: UnsignedTx }>(`${cfg.baseUrl}/approve`, intentBody);
      approveTxHash = await broadcast(cfg, tx, 'approve');
      await sleep(2000);
    }
  }

  // Step 4: the backend builds the intent tx; we only sign it.
  console.log(`\n[4/6] Build + broadcast deposit intent`);
  const created = await postJson<CreateIntentResponse>(
    `${cfg.baseUrl}/intents/deposit`,
    intentBody,
  );
  const hubWallet = getAddress(created.intent.creator);
  console.log(`  intentId   : ${created.intent.intentId}`);
  console.log(`  hub wallet : ${hubWallet}  (intent.creator — the shares' owner, NOT the EOA)`);
  console.log(`  deadline   : ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);
  console.log(`\n  Full create-intent response:`);
  console.dir(created, { depth: null });
  const txHash = await broadcast(cfg, created.tx, 'deposit');

  // Step 5 + 6: submit, then poll to a terminal state.
  console.log(`\n[5/6] Submit to backend`);
  const submitted = await submitLeverageTx(cfg, {
    txHash,
    intent: created.intent,
    relayData: created.relayData,
    operation: 'deposit',
  });

  console.log(`\n[6/6] Poll submit-tx/status`);
  const finalStatus = (await pollIntentStatus(
    txHash,
    cfg.baseUrl,
    cfg.pollIntervalMs,
    cfg.pollTimeoutMs,
    cfg.srcChain.chainKey,
  )) as StatusResponse;
  const proof = assessProof(finalStatus, 'deposit');

  // Confirm the shares actually landed — owned by the derived hub wallet, not the EOA.
  const shares = await getJson<{ balance: string }>(
    `${cfg.baseUrl}/share-balance?vault=${vault.vault}&owner=${hubWallet}`,
  );
  console.log(`    shares held by ${hubWallet}: ${shares.balance}`);

  return {
    leg: 'deposit',
    vaultName: vault.name,
    vaultAddress: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    hubWallet,
    walletAddress: cfg.walletAddress,
    inputToken: cfg.inputToken,
    inputAmount: inputAmount.toString(),
    quotedAmount: quote.quotedAmount,
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
    approveTxHash,
    txHash,
    statusUrl: `${cfg.baseUrl}/submit-tx/status?txHash=${txHash}&srcChainKey=${cfg.srcChain.chainKey}`,
    submitResponse: submitted.response,
    relayDataForm: submitted.relayDataForm,
    finalStatus,
    sharesAfter: shares.balance,
    ...proof,
    elapsedMs: Date.now() - startMs,
  };
}

// ----------------------------------------------------------------------------
// LEG 2 — WITHDRAW (lsoda* shares -> spoke token)
// ----------------------------------------------------------------------------

/**
 * Learn the derived hub wallet without spending anything: build (never broadcast) a 1-unit
 * deposit intent and read `intent.creator`. The `share-balance` / `max-withdraw` owner is
 * that address, not the EOA, so we need it before we can size a withdraw.
 */
async function resolveHubWallet(cfg: Config, vault: Vault): Promise<Address> {
  const probe = await postJson<CreateIntentResponse>(`${cfg.baseUrl}/intents/deposit`, {
    vault: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    srcAddress: cfg.walletAddress,
    inputToken: cfg.inputToken,
    inputAmount: '1',
    minOutputAmount: '0',
  });
  return getAddress(probe.intent.creator);
}

async function runWithdraw(
  cfg: Config,
  vault: Vault,
  known?: { hubWallet: Address },
): Promise<LegEvidence> {
  const startMs = Date.now();
  console.log(`\n${'='.repeat(78)}`);
  console.log(`LEG 2 — leverage WITHDRAW from ${vault.name} (${vault.vault})`);
  console.log(`${'='.repeat(78)}`);

  // Step 1: how many shares can we actually withdraw?
  console.log(`\n[1/5] Share balance (owner = derived hub wallet)`);
  const hubWallet = known?.hubWallet ?? (await resolveHubWallet(cfg, vault));
  console.log(`  hub wallet : ${hubWallet}`);
  const [shareBalance, maxWithdraw] = await Promise.all([
    getJson<{ balance: string }>(
      `${cfg.baseUrl}/share-balance?vault=${vault.vault}&owner=${hubWallet}`,
    ),
    getJson<{ maxWithdraw: string }>(
      `${cfg.baseUrl}/max-withdraw?vault=${vault.vault}&owner=${hubWallet}`,
    ),
  ]);
  console.log(`  share-balance : ${shareBalance.balance}`);
  console.log(
    `  max-withdraw  : ${maxWithdraw.maxWithdraw} (RAW on-chain value, not dust-trimmed)`,
  );

  let shares: bigint;
  if (cfg.explicitWithdrawShares) {
    if (!/^\d+$/.test(cfg.explicitWithdrawShares)) {
      throw new Error('LEVERAGE_WITHDRAW_SHARES must be an integer string (base units)');
    }
    shares = BigInt(cfg.explicitWithdrawShares);
  } else {
    // `max-withdraw` is the raw on-chain figure; feeding it back verbatim can trip the
    // vault's share round-up and revert. Take a buffer off it.
    const ceiling = BigInt(maxWithdraw.maxWithdraw);
    const balance = BigInt(shareBalance.balance);
    const usable = ceiling < balance ? ceiling : balance;
    shares = (usable * (10_000n - cfg.withdrawBufferBps)) / 10_000n;
    console.log(`  withdrawing   : ${shares} (usable − ${cfg.withdrawBufferBps}bps dust buffer)`);
  }
  if (shares <= 0n) {
    throw new Error(
      `No withdrawable shares for ${hubWallet} in ${vault.name}. Run the deposit leg first (pnpm leverage:deposit).`,
    );
  }

  // Step 2: quote the way out.
  console.log(`\n[2/5] Quote withdraw`);
  const quote = await postJson<QuoteResponse>(`${cfg.baseUrl}/quote/withdraw`, {
    vault: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    tokenDst: cfg.outputToken,
    tokenDstChainKey: cfg.dstChainKey,
    amount: shares.toString(),
    quoteType: 'exact_input',
  });
  const minOutputAmount = applySlippage(BigInt(quote.quotedAmount), cfg.slippageBps);
  console.log(`  quotedAmount    : ${quote.quotedAmount}`);
  console.log(`  minOutputAmount : ${minOutputAmount} (quote − ${cfg.slippageBps}bps)`);

  // Step 3: build + broadcast. NO approve step — the shares sit in the hub wallet and the
  // backend sets `hubWalletSwap: true` internally (it bundles the share approval into the
  // same call). Approving here would just burn gas on a no-op.
  console.log(`\n[3/5] Build + broadcast withdraw intent (no approve step by design)`);
  const deadline = unixNow() + cfg.deadlineOffsetSeconds;
  const created = await postJson<CreateIntentResponse>(`${cfg.baseUrl}/intents/withdraw`, {
    vault: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    srcAddress: cfg.walletAddress,
    dstChainKey: cfg.dstChainKey,
    outputToken: cfg.outputToken,
    inputAmount: shares.toString(),
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
    // NB: no `partnerFee` — leverage withdrawals have no such field (deposits do).
    // See icon-project/sodax-sdks#325.
  });
  console.log(`  intentId : ${created.intent.intentId}`);
  console.log(`\n  Full create-intent response:`);
  console.dir(created, { depth: null });
  // Note the asymmetry under test: we sign on `srcChainKey` (a spoke) while the shares — and
  // `intent.srcChain` — are hub-side.
  const txHash = await broadcast(cfg, created.tx, 'withdraw');

  console.log(`\n[4/5] Submit to backend`);
  const submitted = await submitLeverageTx(cfg, {
    txHash,
    intent: created.intent,
    relayData: created.relayData,
    operation: 'withdraw',
  });

  console.log(`\n[5/5] Poll submit-tx/status`);
  const finalStatus = (await pollIntentStatus(
    txHash,
    cfg.baseUrl,
    cfg.pollIntervalMs,
    cfg.pollTimeoutMs,
    cfg.srcChain.chainKey,
  )) as StatusResponse;
  const proof = assessProof(finalStatus, 'withdraw');

  const sharesAfter = await getJson<{ balance: string }>(
    `${cfg.baseUrl}/share-balance?vault=${vault.vault}&owner=${hubWallet}`,
  );
  console.log(`    shares remaining for ${hubWallet}: ${sharesAfter.balance}`);

  return {
    leg: 'withdraw',
    vaultName: vault.name,
    vaultAddress: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    dstChainKey: cfg.dstChainKey,
    hubWallet,
    walletAddress: cfg.walletAddress,
    inputToken: vault.vault,
    inputAmount: shares.toString(),
    quotedAmount: quote.quotedAmount,
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
    txHash,
    statusUrl: `${cfg.baseUrl}/submit-tx/status?txHash=${txHash}&srcChainKey=${cfg.srcChain.chainKey}`,
    submitResponse: submitted.response,
    relayDataForm: submitted.relayDataForm,
    finalStatus,
    sharesAfter: sharesAfter.balance,
    ...proof,
    elapsedMs: Date.now() - startMs,
  };
}

// ----------------------------------------------------------------------------
// READ-ONLY DISCOVERY (spends nothing)
// ----------------------------------------------------------------------------

async function runDiscovery(cfg: Config): Promise<void> {
  console.log(`\nLeverage Yield — read-only discovery (no funds spent)`);
  console.log(`Wallet : ${cfg.walletAddress}`);
  console.log(`Source : ${cfg.srcChain.name} (${cfg.srcChain.chainKey})`);

  console.log(`\n[1/5] GET /vaults`);
  const vaults = await fetchVaults(cfg);
  for (const v of vaults) {
    console.log(`  ${v.name.padEnd(14)} vault=${v.vault} asset=${v.asset}`);
    console.log(
      `  ${''.padEnd(14)} borrowToken=${v.borrowToken}${v.lsdSource ? ` lsd=${v.lsdSource.label} (~${v.lsdSource.fallbackAprPct}% APR)` : ''}`,
    );
  }
  const vault = selectVault(vaults, cfg);
  console.log(`  Selected: ${vault.name} (${vault.vault})`);

  console.log(`\n[2/5] POST /quote/deposit`);
  const token = await readTokenInfo(cfg, cfg.inputToken);
  const inputAmount = resolveInputAmount(cfg, token);
  const depositQuote = await postJson<QuoteResponse>(`${cfg.baseUrl}/quote/deposit`, {
    vault: vault.vault,
    tokenSrc: cfg.inputToken,
    tokenSrcChainKey: cfg.srcChain.chainKey,
    amount: inputAmount.toString(),
    quoteType: 'exact_input',
  });
  console.log(
    `  ${formatUnits(inputAmount, token.decimals)} ${token.symbol} -> ${depositQuote.quotedAmount} ${vault.name} shares`,
  );
  console.log(
    `  minOutputAmount at ${cfg.slippageBps}bps: ${applySlippage(BigInt(depositQuote.quotedAmount), cfg.slippageBps)}`,
  );
  console.log(`  wallet ${token.symbol} balance: ${formatUnits(token.balance, token.decimals)}`);

  console.log(`\n[3/5] Derived hub wallet + share position (build-only probe, nothing broadcast)`);
  const hubWallet = await resolveHubWallet(cfg, vault);
  const [shareBalance, maxWithdraw] = await Promise.all([
    getJson<{ balance: string }>(
      `${cfg.baseUrl}/share-balance?vault=${vault.vault}&owner=${hubWallet}`,
    ),
    getJson<{ maxWithdraw: string }>(
      `${cfg.baseUrl}/max-withdraw?vault=${vault.vault}&owner=${hubWallet}`,
    ),
  ]);
  console.log(`  hub wallet (intent.creator) : ${hubWallet}`);
  console.log(`  EOA                         : ${cfg.walletAddress}`);
  console.log(`  share-balance               : ${shareBalance.balance}`);
  console.log(`  max-withdraw (RAW)          : ${maxWithdraw.maxWithdraw}`);

  console.log(`\n[4/5] POST /quote/withdraw`);
  // Quote the round trip: whatever the deposit above would mint, priced back out.
  const withdrawProbe =
    BigInt(shareBalance.balance) > 0n
      ? BigInt(shareBalance.balance)
      : BigInt(depositQuote.quotedAmount);
  const withdrawQuote = await postJson<QuoteResponse>(`${cfg.baseUrl}/quote/withdraw`, {
    vault: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    tokenDst: cfg.outputToken,
    tokenDstChainKey: cfg.dstChainKey,
    amount: withdrawProbe.toString(),
    quoteType: 'exact_input',
  });
  console.log(
    `  ${withdrawProbe} ${vault.name} shares -> ${withdrawQuote.quotedAmount} (${cfg.outputToken} on ${cfg.dstChainKey})`,
  );

  console.log(`\n[5/5] Negative test — malformed vault must be 400 (not a 502)`);
  const negative = await postRaw(`${cfg.baseUrl}/quote/deposit`, {
    vault: 'not-an-address',
    tokenSrc: cfg.inputToken,
    tokenSrcChainKey: cfg.srcChain.chainKey,
    amount: inputAmount.toString(),
    quoteType: 'exact_input',
  });
  console.log(`  HTTP ${negative.status}: ${negative.body}`);
  console.log(
    `  ${negative.status === 400 ? 'PASS — rejected with 400' : `FAIL — expected 400, got ${negative.status}`}`,
  );
}

// ----------------------------------------------------------------------------
// PROOF REPORT
// ----------------------------------------------------------------------------

function proofBlock(e: LegEvidence): string {
  const lines = [
    `### ${e.leg === 'deposit' ? 'Leg 1 — EVM-spoke deposit' : 'Leg 2 — EVM-spoke withdraw'} (${e.vaultName})`,
    ``,
    `- vault         : ${e.vaultAddress}`,
    `- srcChainKey   : ${e.srcChainKey}`,
    ...(e.dstChainKey ? [`- dstChainKey   : ${e.dstChainKey}`] : []),
    `- source tx     : ${e.txHash}`,
    ...(e.approveTxHash ? [`- approve tx    : ${e.approveTxHash}`] : []),
    `- EOA signer    : ${e.walletAddress}`,
    `- hub wallet    : ${e.hubWallet} (shares owner)`,
    `- inputAmount   : ${e.inputAmount}`,
    `- quotedAmount  : ${e.quotedAmount}`,
    `- minOutput     : ${e.minOutputAmount}`,
    ...(e.sharesAfter !== undefined ? [`- shares after  : ${e.sharesAfter}`] : []),
    `- elapsed       : ${Math.round(e.elapsedMs / 1000)}s`,
    ``,
    `Final \`GET ${redactOrigin(e.statusUrl)}\`:`,
    ``,
    '```json',
    JSON.stringify(e.finalStatus, null, 2),
    '```',
    ``,
    `Proof: operation=\`${e.statusOperation}\` (expected \`${e.expectedOperation}\`), status=\`${e.statusValue}\` -> ${e.proofOk ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}

function writeProofReport(evidence: LegEvidence[]): { txt: string; json: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const files = { txt: `leverage-yield-proof-${ts}.txt`, json: `leverage-yield-proof-${ts}.json` };

  const header = [
    `Leverage Yield API — money-path test (icon-project/sodax-backend#1029)`,
    `Run at: ${new Date().toISOString()}`,
    `Backend: <LEVERAGE_YIELD_ENDPOINT>/leverage-yield  (origin redacted — not yet gateway-routed)`,
    ``,
  ].join('\n');

  writeFileSync(files.txt, `${header}${evidence.map(proofBlock).join('\n\n')}\n`, 'utf-8');
  writeFileSync(
    files.json,
    `${JSON.stringify(
      {
        issue: 'icon-project/sodax-backend#1029',
        runAt: new Date().toISOString(),
        backend: '<LEVERAGE_YIELD_ENDPOINT>/leverage-yield',
        legs: evidence.map((e) => ({ ...e, statusUrl: redactOrigin(e.statusUrl) })),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return files;
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

const USAGE = `Usage: tsx leverage-yield.ts <mode>

  --vaults        Read-only discovery: vaults, both quotes, hub wallet, share position,
                  and the malformed-vault 400 negative test. Spends nothing.
  --deposit       Leg 1: spoke token -> lsoda* shares. SPENDS REAL FUNDS.
  --withdraw      Leg 2: lsoda* shares -> spoke token. SPENDS REAL FUNDS.
  --round-trip    Leg 1 then Leg 2 back to back. SPENDS REAL FUNDS.`;

async function main() {
  const mode = process.argv[2] ?? '--vaults';
  const cfg = loadConfig();

  if (mode === '--help' || mode === '-h') {
    console.log(USAGE);
    return;
  }
  if (mode === '--vaults') {
    await runDiscovery(cfg);
    return;
  }
  if (mode !== '--deposit' && mode !== '--withdraw' && mode !== '--round-trip') {
    console.error(`Unknown flag: ${mode}\n\n${USAGE}`);
    process.exit(1);
  }

  const startMs = Date.now();
  const vault = selectVault(await fetchVaults(cfg), cfg);
  console.log(`\nLeverage Yield money-path test — ${mode.replace('--', '')}`);
  console.log(`Wallet : ${cfg.walletAddress}`);
  console.log(`Source : ${cfg.srcChain.name} (${cfg.srcChain.chainKey})`);
  console.log(`Vault  : ${vault.name} (${vault.vault})`);

  const evidence: LegEvidence[] = [];
  try {
    if (mode === '--deposit' || mode === '--round-trip') {
      evidence.push(await runDeposit(cfg, vault));
    }
    if (mode === '--withdraw' || mode === '--round-trip') {
      const hubWallet = evidence[0]?.hubWallet;
      evidence.push(await runWithdraw(cfg, vault, hubWallet ? { hubWallet } : undefined));
    }
  } finally {
    // Always save whatever legs completed — a leg that reached a terminal state is evidence
    // even if a later one throws.
    if (evidence.length > 0) {
      const files = writeProofReport(evidence);
      console.log(`\nProof report written (origin redacted):`);
      console.log(`  ${files.txt}`);
      console.log(`  ${files.json}`);
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  for (const e of evidence) {
    console.log(
      `${e.leg.toUpperCase().padEnd(9)} ${e.proofOk ? 'PASS' : 'FAIL'}  operation=${e.statusOperation || '(missing)'} status=${e.statusValue || '(missing)'} tx=${e.txHash}`,
    );
  }
  console.log(`Elapsed: ${formatElapsed(startMs)}`);

  if (evidence.some((e) => !e.proofOk)) {
    console.error(`\nAt least one leg did not produce the required proof (solved + leverage_*).`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nFailed:`, error);
  process.exit(1);
});
