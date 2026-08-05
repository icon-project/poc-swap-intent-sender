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
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { EvmRawTransaction, SpokeChainKey } from '@sodax/sdk';
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
  SOLANA_DEF,
  SOLANA_NATIVE,
  type SolanaChainDef,
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
// Both legs run from an EVM spoke or from Solana (`LEVERAGE_SRC_CHAIN_KEY=solana`). The
// Solana source is #1029's leg 3 — the split-tx / `hubWalletSwap` path, where the user signs
// on a non-EVM spoke while the intent and the shares live hub-side. It needs no Solana SDK
// support: the backend returns the whole transaction already serialized, so the only extra
// work is ed25519 signing (see `signAndSendSolana`) and coping with blockhash expiry.
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

/**
 * An unsigned tx built by the backend. Deliberately typed loosely because its contents are
 * chain-specific:
 *
 * - **EVM**: `to` is a `0x…` contract address and `data` is calldata hex — fed to the wallet
 *   provider as-is.
 * - **Solana**: `data` is base64 of a *fully serialized* unsigned v0 `VersionedTransaction`
 *   (empty signature slot + message, blockhash already baked in). `to` is incidental; there is
 *   nothing left to assemble locally.
 */
type UnsignedTx = { from?: string; to: string; data: string; value?: string };

/**
 * The intent as the backend serializes it (bigints already decimal strings). It goes back
 * to `submit-tx` verbatim — no rehydration, unlike the SDK-built swap path.
 */
type BackendIntent = Record<string, unknown> & { creator: Address; intentId: string };

type CreateIntentResponse = {
  tx: UnsignedTx;
  intent: BackendIntent;
  /**
   * `address` is the derived hub wallet (always an EVM address, even for a Solana source).
   * `payload` is relay-consumed and only actually read for non-EVM sources — EVM flows relay
   * `{ chain_id, tx_hash }` and ignore it.
   */
  relayData: { address: Address; payload: string };
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

// ----------------------------------------------------------------------------
// CHAIN REGISTRY (EVM + Solana)
// ----------------------------------------------------------------------------
//
// Leg 3 means the source spoke can no longer be assumed EVM. `ChainEntry` is the discriminated
// union every chain-sensitive path branches on. The fields shared by both chain types are flat
// so the bulk of the script reads unchanged; the chain-specific plumbing hangs off `evm` /
// `solana` and is only reachable after narrowing on `kind`.

type ChainCommon = {
  chainKey: SpokeChainKey;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
};

type ChainEntry =
  | (ChainCommon & { kind: 'evm'; evm: ChainDef })
  | (ChainCommon & { kind: 'solana'; solana: SolanaChainDef });

/** Every chain this script can source from or pay out to, keyed by short registry name. */
const CHAIN_ENTRIES: Record<string, ChainEntry> = {
  ...Object.fromEntries(
    Object.entries(CHAIN_DEFS).map(([key, def]): [string, ChainEntry] => [
      key,
      {
        kind: 'evm',
        chainKey: def.chainKey,
        name: def.name,
        nativeSymbol: def.nativeSymbol,
        nativeDecimals: 18,
        evm: def,
      },
    ]),
  ),
  solana: {
    kind: 'solana',
    chainKey: SOLANA_DEF.chainKey,
    name: SOLANA_DEF.name,
    nativeSymbol: SOLANA_DEF.nativeSymbol,
    nativeDecimals: SOLANA_DEF.nativeDecimals,
    solana: SOLANA_DEF,
  },
};

const CHAIN_KEY_LIST = Object.keys(CHAIN_ENTRIES).join(', ');

/** Look a chain up by registry key (`arbitrum`, `solana`) or SpokeChainKey (`0xa4b1.arbitrum`). */
function findChainEntry(value: string): ChainEntry | undefined {
  return (
    CHAIN_ENTRIES[value] ??
    Object.values(CHAIN_ENTRIES).find((e) => e.chainKey.toLowerCase() === value)
  );
}

function resolveChainEntry(envVar: string, fallbackKey: string): ChainEntry {
  const key = (process.env[envVar] || fallbackKey).trim().toLowerCase();
  const entry = findChainEntry(key);
  if (!entry) {
    throw new Error(`${envVar}='${key}' is not a known chain. Valid keys: ${CHAIN_KEY_LIST}`);
  }
  return entry;
}

/**
 * EVM-only plumbing (viem chain + RPC env var). Every caller narrows on `kind` first; this
 * exists so the narrowing failure is a clear error rather than an undefined dereference.
 */
function requireEvm(chain: ChainEntry): ChainDef {
  if (chain.kind !== 'evm') {
    throw new Error(`${chain.name} is not an EVM chain — this code path requires an EVM source`);
  }
  return chain.evm;
}

// ----------------------------------------------------------------------------
// SOLANA SIGNER
// ----------------------------------------------------------------------------

let cachedSolanaKeypair: Keypair | undefined;

/**
 * The Solana signer.
 *
 * By default it is derived from the **existing `PRIVATE_KEY`** — a 32-byte secp256k1 key is
 * also a valid ed25519 seed, so this demo wallet needs no second secret to manage. The two
 * addresses are unrelated: the same `.env` yields one EVM EOA and one Solana pubkey.
 *
 * `SOLANA_PRIVATE_KEY` overrides it with a real Solana key — useful for importing a wallet
 * that already holds SOL. Accepts a JSON array of 64 bytes (`solana-keygen` / `id.json`) or
 * 128 hex chars. A base58 export (e.g. Phantom) must be converted to one of those first;
 * decoding base58 here would mean pulling in another dependency for no real gain.
 */
function solanaKeypair(privateKey: Hex): Keypair {
  if (cachedSolanaKeypair) return cachedSolanaKeypair;

  const override = process.env.SOLANA_PRIVATE_KEY?.trim();
  if (override) {
    cachedSolanaKeypair = Keypair.fromSecretKey(parseSolanaSecretKey(override));
    return cachedSolanaKeypair;
  }

  const seed = Buffer.from(privateKey.slice(2), 'hex');
  if (seed.length !== 32) {
    throw new Error(
      `PRIVATE_KEY must be 32 bytes (64 hex chars) to derive a Solana keypair, got ${seed.length}. Set SOLANA_PRIVATE_KEY instead.`,
    );
  }
  cachedSolanaKeypair = Keypair.fromSeed(seed);
  return cachedSolanaKeypair;
}

function parseSolanaSecretKey(raw: string): Uint8Array {
  if (raw.startsWith('[')) {
    const bytes: unknown = JSON.parse(raw);
    if (!Array.isArray(bytes) || bytes.length !== 64) {
      throw new Error('SOLANA_PRIVATE_KEY as JSON must be an array of exactly 64 bytes');
    }
    return Uint8Array.from(bytes as number[]);
  }
  const hex = raw.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
    throw new Error(
      'SOLANA_PRIVATE_KEY must be a JSON array of 64 bytes or 128 hex chars (convert a base58 export first)',
    );
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function solanaConnection(chain: ChainEntry): Connection {
  return new Connection(
    getRpcUrl(chain.kind === 'solana' ? chain.solana : SOLANA_DEF),
    'confirmed',
  );
}

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------

type Config = {
  baseUrl: string;
  srcChain: ChainEntry;
  dstChain: ChainEntry;
  dstChainKey: string;
  privateKey: Hex;
  /** The EVM EOA — signs on EVM spokes and is the subject of every EVM balance read. */
  evmAddress: Address;
  /**
   * The address the API sees as `srcAddress` / `walletAddress`. A base58 pubkey for a Solana
   * source, the EVM EOA otherwise. (`submit-tx` validates it as a 1–127 char string, not as an
   * EVM address, precisely so a Solana pubkey is accepted.)
   */
  signerAddress: string;
  vaultSelector: { address?: Address; name?: string };
  inputToken: string;
  outputToken: string;
  slippageBps: bigint;
  withdrawBufferBps: bigint;
  deadlineOffsetSeconds: bigint;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  explicitInputAmount?: string;
  explicitWithdrawShares?: string;
  inputAmountHuman?: string;
};

/**
 * Validate a token address against the chain it belongs to. EVM spokes use `0x…`; Solana uses
 * base58 — and spells native SOL as the system program id rather than a zero address, so that
 * value is allowed through without a base58 round-trip.
 */
function parseToken(name: string, value: string, chain: ChainEntry): string {
  if (chain.kind === 'solana') {
    if (value === SOLANA_NATIVE) return value;
    try {
      return new PublicKey(value).toBase58();
    } catch {
      throw new Error(`${name}='${value}' is not a valid Solana address`);
    }
  }
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`);
  return getAddress(value);
}

function getTokenEnv(name: string, fallback: string, chain: ChainEntry): string {
  const value = process.env[name];
  return value ? parseToken(name, value, chain) : fallback;
}

/** Vaults are always hub-side, so a vault selector is an EVM address whatever the source is. */
function parseEvmAddress(name: string, value: string): Address {
  if (!isAddress(value)) throw new Error(`${name} is not a valid EVM address`);
  return getAddress(value);
}

/** The chain's own spelling of its native gas token. */
function nativeTokenOf(chain: ChainEntry): string {
  return chain.kind === 'solana' ? SOLANA_NATIVE : getAddress(NATIVE);
}

function loadConfig(): Config {
  const privateKey = normalizePrivateKey(getRequiredEnv('PRIVATE_KEY'));
  const account = privateKeyToAccount(privateKey);
  const srcChain = resolveChainEntry('LEVERAGE_SRC_CHAIN_KEY', 'sonic');
  // Destination defaults to the source, i.e. a round trip. Resolving it as a full entry (not
  // just a key) is what lets `outputToken` be validated against the right chain type.
  const dstChain = process.env.LEVERAGE_DST_CHAIN_KEY
    ? resolveChainEntry('LEVERAGE_DST_CHAIN_KEY', srcChain.chainKey)
    : srcChain;

  // Default input: USDT on Sonic (what this wallet holds), native gas token elsewhere —
  // the same convention `chain-hop.ts` uses for spokes.
  const defaultToken =
    srcChain.chainKey === 'sonic' ? getAddress(SONIC_USDT) : nativeTokenOf(srcChain);
  const inputToken = getTokenEnv('LEVERAGE_INPUT_TOKEN', defaultToken, srcChain);

  return {
    baseUrl: getLeverageBaseUrl(),
    srcChain,
    dstChain,
    dstChainKey: dstChain.chainKey,
    privateKey,
    evmAddress: account.address,
    signerAddress:
      srcChain.kind === 'solana' ? solanaKeypair(privateKey).publicKey.toBase58() : account.address,
    vaultSelector: {
      address: process.env.LEVERAGE_VAULT
        ? parseEvmAddress('LEVERAGE_VAULT', process.env.LEVERAGE_VAULT)
        : undefined,
      name: process.env.LEVERAGE_VAULT_NAME,
    },
    inputToken,
    // Withdraw back into the deposit token by default, i.e. a round trip.
    outputToken: getTokenEnv('LEVERAGE_OUTPUT_TOKEN', inputToken, dstChain),
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

/** Is this the chain's native gas token, in whichever spelling that chain uses? */
function isNativeOn(token: string, chain: ChainEntry): boolean {
  return chain.kind === 'solana'
    ? token === SOLANA_NATIVE
    : token.toLowerCase() === NATIVE.toLowerCase();
}

function spokePublicClient(def: ChainDef) {
  return createPublicClient({ chain: def.viemChain, transport: http(getRpcUrl(def)) });
}

type TokenInfo = { symbol: string; decimals: number; balance: bigint };

async function readTokenInfo(cfg: Config, token: string): Promise<TokenInfo> {
  if (cfg.srcChain.kind === 'solana') return readSolanaTokenInfo(cfg, token);

  const def = requireEvm(cfg.srcChain);
  const client = spokePublicClient(def);
  if (isNativeOn(token, cfg.srcChain)) {
    return {
      symbol: cfg.srcChain.nativeSymbol,
      decimals: cfg.srcChain.nativeDecimals,
      balance: await client.getBalance({ address: cfg.evmAddress }),
    };
  }
  const erc20 = parseEvmAddress('inputToken', token);
  const [symbol, decimals, balance] = await Promise.all([
    client
      .readContract({ address: erc20, abi: erc20Abi, functionName: 'symbol' })
      .catch(() => '???'),
    client.readContract({ address: erc20, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({
      address: erc20,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [cfg.evmAddress],
    }),
  ]);
  return { symbol, decimals: Number(decimals), balance };
}

/**
 * Solana-side balance read. Only native SOL is supported: an SPL input would need
 * associated-token-account discovery, and native SOL is what leg 3 deposits anyway — it is also
 * the cheapest input, since an SPL deposit additionally pays ATA rent.
 */
async function readSolanaTokenInfo(cfg: Config, token: string): Promise<TokenInfo> {
  if (!isNativeOn(token, cfg.srcChain)) {
    throw new Error(
      `SPL token inputs are not implemented for a Solana source (got ${token}). Use native SOL (${SOLANA_NATIVE}).`,
    );
  }
  const lamports = await solanaConnection(cfg.srcChain).getBalance(
    new PublicKey(cfg.signerAddress),
  );
  return {
    symbol: cfg.srcChain.nativeSymbol,
    decimals: cfg.srcChain.nativeDecimals,
    balance: BigInt(lamports),
  };
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
  if (isNativeOn(cfg.inputToken, cfg.srcChain)) {
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

/** How long to wait for a Solana signature to confirm, and how often to check. */
const SOLANA_CONFIRM_TIMEOUT_MS = 90_000;
const SOLANA_CONFIRM_POLL_MS = 1500;
/** Build attempts for a Solana source — each retry fetches a tx with a fresh blockhash. */
const SOLANA_BUILD_ATTEMPTS = 3;
/** Lamports a native SOL deposit must leave behind to pay its own fee (~5000 is typical). */
const SOLANA_FEE_HEADROOM_LAMPORTS = 1_000_000n;

/**
 * Raised only when a Solana blockhash has **provably** expired, which means the transaction can
 * never land. That distinction is what makes a rebuild safe: retrying a merely-slow tx could
 * double-spend, retrying a permanently-dead one cannot.
 */
class BlockhashExpiredError extends Error {}

/** Sign and broadcast on the source spoke, dispatching on chain type. */
async function signAndSend(cfg: Config, tx: UnsignedTx, label: string): Promise<string> {
  return cfg.srcChain.kind === 'solana'
    ? signAndSendSolana(cfg, tx, label)
    : broadcastEvm(cfg, tx, label);
}

/**
 * Sign and broadcast one of the backend's unsigned txs on an EVM source spoke, then wait for
 * the receipt. `ViemWalletProvider` is reused for its EIP-1559 fallback (some spoke RPCs
 * mis-estimate fees). A reverted tx throws here so we never submit it to the backend.
 */
async function broadcastEvm(cfg: Config, tx: UnsignedTx, label: string): Promise<Hex> {
  const def = requireEvm(cfg.srcChain);
  const provider = new ViemWalletProvider(cfg.privateKey, def.viemChain, getRpcUrl(def));
  console.log(`  ${label}: to=${tx.to} value=${tx.value ?? '0'} dataLen=${tx.data.length}`);

  const hash = (await provider.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
  } as unknown as EvmRawTransaction)) as Hex;
  console.log(`  ${label} tx: ${hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await spokePublicClient(def).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label} tx ${hash} reverted on-chain (block ${receipt.blockNumber})`);
  }
  console.log(`  Confirmed in block ${receipt.blockNumber} | gas used: ${receipt.gasUsed}`);
  return hash;
}

/**
 * Sign and broadcast a Solana source tx.
 *
 * There is nothing to assemble locally: `tx.data` is base64 of a fully serialized unsigned v0
 * `VersionedTransaction` — one empty signature slot plus the message, blockhash already baked
 * in — so we deserialize, sign with ed25519, and push the raw bytes. This is exactly why leg 3
 * needs no SDK Solana wallet provider.
 *
 * The returned hash is a **base58 signature**, not `0x…`; that string is what `submit-tx` and
 * `submit-tx/status` key on.
 */
async function signAndSendSolana(cfg: Config, tx: UnsignedTx, label: string): Promise<string> {
  const connection = solanaConnection(cfg.srcChain);
  const keypair = solanaKeypair(cfg.privateKey);
  const raw = Buffer.from(tx.data, 'base64');
  const vtx = VersionedTransaction.deserialize(raw);
  const blockhash = vtx.message.recentBlockhash;
  console.log(
    `  ${label}: ${raw.length}B serialized, v${vtx.version}, ` +
      `${vtx.message.compiledInstructions.length} instructions, ` +
      `${vtx.message.staticAccountKeys.length} account keys, blockhash ${blockhash}`,
  );

  vtx.sign([keypair]);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  } catch (err) {
    if (isBlockhashExpiryError(err)) {
      throw new BlockhashExpiredError(`${label}: blockhash ${blockhash} expired before send`);
    }
    throw err;
  }
  console.log(`  ${label} tx: ${signature}`);
  console.log(`  Waiting for confirmation...`);
  await confirmSolanaSignature(connection, signature, blockhash, label);
  return signature;
}

/** The RPC's way of saying the embedded blockhash is already too old to accept. */
function isBlockhashExpiryError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err);
  return /blockhash not found|block height exceeded|BlockhashNotFound/i.test(message);
}

/**
 * Poll until the signature confirms.
 *
 * If it has not landed *and* its blockhash is no longer valid, the transaction is permanently
 * dead and that is surfaced as `BlockhashExpiredError` so the caller can rebuild. Checking
 * blockhash validity rather than just timing out is the safety property here — a bare timeout
 * cannot distinguish "dead" from "slow", and rebuilding on "slow" risks a second deposit.
 */
async function confirmSolanaSignature(
  connection: Connection,
  signature: string,
  blockhash: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + SOLANA_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];

    if (status?.err) {
      throw new Error(`${label} tx ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      console.log(`  Confirmed (${status.confirmationStatus}) in slot ${status.slot}`);
      return;
    }
    if (!status) {
      const stillValid = (await connection.isBlockhashValid(blockhash, { commitment: 'confirmed' }))
        .value;
      if (!stillValid) {
        throw new BlockhashExpiredError(
          `${label}: blockhash ${blockhash} expired with no signature status — the tx can never land`,
        );
      }
    }
    await sleep(SOLANA_CONFIRM_POLL_MS);
  }
  throw new Error(
    `${label} tx ${signature} did not confirm within ${SOLANA_CONFIRM_TIMEOUT_MS}ms. ` +
      `Check it on an explorer before re-running — it may still land.`,
  );
}

/**
 * Build the intent, then sign and send it — refetching the tx if the blockhash expires.
 *
 * A Solana transaction embeds a blockhash valid for only ~60–90s, so unlike every EVM leg so
 * far the payload cannot sit around between build and broadcast, and a stale one must never be
 * resent. On a provable expiry we call the builder again for fresh bytes. A rebuild produces a
 * *different* intent, so this returns whichever pair actually confirmed and only that one is
 * submitted. EVM sources have no expiry and so never retry.
 */
async function buildSignSend(
  cfg: Config,
  build: () => Promise<CreateIntentResponse>,
  label: string,
): Promise<{ created: CreateIntentResponse; txHash: string }> {
  const attempts = cfg.srcChain.kind === 'solana' ? SOLANA_BUILD_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const created = await build();
    if (attempt === 1) {
      console.log(`  intentId   : ${created.intent.intentId}`);
      console.log(`\n  Full create-intent response:`);
      console.dir(created, { depth: null });
    } else {
      console.log(
        `  Rebuilt (attempt ${attempt}/${attempts}) intentId: ${created.intent.intentId}`,
      );
    }

    try {
      return { created, txHash: await signAndSend(cfg, created.tx, label) };
    } catch (err) {
      if (!(err instanceof BlockhashExpiredError) || attempt === attempts) throw err;
      console.log(`  ${err.message}`);
      console.log(`  Re-calling the builder for a tx with a fresh blockhash...`);
    }
  }
  throw new Error(`${label}: exhausted ${attempts} build attempts`);
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
    txHash: string;
    intent: BackendIntent;
    relayData: CreateIntentResponse['relayData'];
    operation: Operation;
  },
): Promise<{ response: SubmitResponse; relayDataForm: 'payload' | 'object' }> {
  const url = `${cfg.baseUrl}/submit-tx`;
  const base = {
    txHash: args.txHash,
    srcChainKey: cfg.srcChain.chainKey,
    walletAddress: cfg.signerAddress,
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
  srcChainName: string;
  /** `solana` here is what makes a leg the #1029 leg-3 evidence rather than a repeat of 1/2. */
  srcChainKind: ChainEntry['kind'];
  dstChainKey?: string;
  hubWallet: Address;
  /** Base58 pubkey for a Solana source, EVM EOA otherwise. */
  signerAddress: string;
  inputToken: string;
  inputAmount: string;
  quotedAmount: string;
  minOutputAmount: string;
  deadline: string;
  approveTxHash?: string;
  /** Base58 signature for a Solana source, `0x…` hash otherwise. */
  txHash: string;
  /**
   * Structural fields lifted off the create-intent response. `submit-tx/status` does NOT echo
   * the intent, so without capturing them here the non-EVM divergence (a `solana` source row
   * against a hub-side `intent.srcChain`) cannot be shown from the saved evidence alone.
   */
  intentSrcChain?: string;
  intentSrcAddress?: string;
  intentCreator?: string;
  relayDataAddress?: string;
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

/**
 * Lift the structural intent fields off the create-intent response. `submit-tx/status` does not
 * echo the intent, so these have to be recorded at build time or they are lost to the evidence.
 */
function intentFields(created: CreateIntentResponse) {
  const asString = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  return {
    intentSrcChain: asString(created.intent.srcChain),
    intentSrcAddress: asString(created.intent.srcAddress),
    intentCreator: asString(created.intent.creator),
    relayDataAddress: created.relayData.address,
  };
}

/**
 * Read the hub wallet's share position for the evidence record.
 *
 * Deliberately **soft**. By the time this runs the leg has already reached a terminal status, so
 * a transient failure on this auxiliary read must not throw — doing so would propagate out of the
 * leg, leave `evidence` empty, and make `main`'s `finally` skip the proof report entirely,
 * discarding the only artifact from a run that spent real funds.
 */
async function readSharesSoft(
  cfg: Config,
  vault: Vault,
  hubWallet: Address,
  label: string,
): Promise<string | undefined> {
  try {
    const { balance } = await getJson<{ balance: string }>(
      `${cfg.baseUrl}/share-balance?vault=${vault.vault}&owner=${hubWallet}`,
    );
    console.log(`    ${label} ${hubWallet}: ${balance}`);
    return balance;
  } catch (err) {
    console.log(`    ${label} ${hubWallet}: unavailable — ${(err as Error).message}`);
    console.log(`    (evidence is unaffected; the leg already reached a terminal status)`);
    return undefined;
  }
}

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
  // A native deposit spends the same balance the tx fee comes out of, so depositing right up to
  // the balance leaves nothing to pay with. Solana fees are ~5000 lamports; 0.001 SOL is ample.
  if (cfg.srcChain.kind === 'solana' && isNativeOn(cfg.inputToken, cfg.srcChain)) {
    const headroom = SOLANA_FEE_HEADROOM_LAMPORTS;
    if (token.balance - inputAmount < headroom) {
      throw new Error(
        `Deposit would leave ${token.balance - inputAmount} lamports for fees; keep at least ${headroom}. ` +
          `Lower LEVERAGE_INPUT_AMOUNT_HUMAN or top up ${cfg.signerAddress}.`,
      );
    }
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
    srcAddress: cfg.signerAddress,
    inputToken: cfg.inputToken,
    inputAmount: inputAmount.toString(),
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
  };

  // Step 3: allowance/check + approve — the backend's own endpoints, so this run exercises
  // them too rather than approving locally via `approveIfNeeded`.
  console.log(`\n[3/6] Allowance check`);
  let approveTxHash: string | undefined;
  if (isNativeOn(cfg.inputToken, cfg.srcChain)) {
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
      approveTxHash = await signAndSend(cfg, tx, 'approve');
      await sleep(2000);
    }
  }

  // Step 4: the backend builds the intent tx; we only sign it. For a Solana source the build
  // and the broadcast must stay back to back — the tx carries a blockhash that expires in
  // ~60–90s — so `buildSignSend` owns both and refetches if it goes stale.
  console.log(`\n[4/6] Build + broadcast deposit intent`);
  console.log(`  deadline   : ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);
  const { created, txHash } = await buildSignSend(
    cfg,
    () => postJson<CreateIntentResponse>(`${cfg.baseUrl}/intents/deposit`, intentBody),
    'deposit',
  );
  const hubWallet = getAddress(created.intent.creator);
  console.log(`  hub wallet : ${hubWallet}  (intent.creator — the shares' owner, NOT the EOA)`);

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
  const sharesAfter = await readSharesSoft(cfg, vault, hubWallet, 'shares held by');

  return {
    leg: 'deposit',
    vaultName: vault.name,
    vaultAddress: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    srcChainName: cfg.srcChain.name,
    srcChainKind: cfg.srcChain.kind,
    hubWallet,
    signerAddress: cfg.signerAddress,
    inputToken: cfg.inputToken,
    inputAmount: inputAmount.toString(),
    quotedAmount: quote.quotedAmount,
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
    approveTxHash,
    txHash,
    ...intentFields(created),
    statusUrl: `${cfg.baseUrl}/submit-tx/status?txHash=${txHash}&srcChainKey=${cfg.srcChain.chainKey}`,
    submitResponse: submitted.response,
    relayDataForm: submitted.relayDataForm,
    finalStatus,
    sharesAfter,
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
  const probe = (inputAmount: string) =>
    postJson<CreateIntentResponse>(`${cfg.baseUrl}/intents/deposit`, {
      vault: vault.vault,
      srcChainKey: cfg.srcChain.chainKey,
      srcAddress: cfg.signerAddress,
      inputToken: cfg.inputToken,
      inputAmount,
      minOutputAmount: '0',
    });

  try {
    return getAddress((await probe('1')).intent.creator);
  } catch (err) {
    // A 1-unit probe can be rejected as dust — the builder still has to price a route for it.
    // Retry once with something routable. Size it in the INPUT TOKEN's decimals, not the chain's
    // native ones: 0.01 USDT (6dp) is 1e4, while 0.01 of an 18dp token is 1e16, so using native
    // decimals on the default Sonic USDT source would ask for ~10 billion USDT and be rejected
    // again. Nothing is broadcast here, so the amount only has to be routable.
    try {
      const { decimals, symbol } = await readTokenInfo(cfg, cfg.inputToken);
      const fallback = parseUnits('0.01', decimals).toString();
      console.log(`  1-unit probe rejected; retrying with 0.01 ${symbol} (${fallback})`);
      return getAddress((await probe(fallback)).intent.creator);
    } catch {
      // Surface the original dust rejection — it is the informative one, and the fallback may
      // have failed for an unrelated reason (e.g. an unsupported SPL balance read).
      throw err;
    }
  }
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

  // The real ceiling is the lower of the two: the position caps what exists, `max-withdraw` caps
  // what the leveraged position will release.
  const ceiling = BigInt(maxWithdraw.maxWithdraw);
  const balance = BigInt(shareBalance.balance);
  const usable = ceiling < balance ? ceiling : balance;

  let shares: bigint;
  if (cfg.explicitWithdrawShares) {
    if (!/^\d+$/.test(cfg.explicitWithdrawShares)) {
      throw new Error('LEVERAGE_WITHDRAW_SHARES must be an integer string (base units)');
    }
    shares = BigInt(cfg.explicitWithdrawShares);
    // Even the raw ceiling can revert on-chain via the vault's share round-up, so anything above
    // it is a guaranteed wasted broadcast. Refuse here rather than pay gas to discover it.
    if (shares > usable) {
      throw new Error(
        `LEVERAGE_WITHDRAW_SHARES=${shares} exceeds the withdrawable ceiling ${usable} ` +
          `(the lower of max-withdraw ${ceiling} and share-balance ${balance}). ` +
          `Lower it, or unset it to size automatically with the ${cfg.withdrawBufferBps}bps dust buffer.`,
      );
    }
    console.log(`  withdrawing   : ${shares} (explicit, within the ${usable} ceiling)`);
  } else {
    // `max-withdraw` is the raw on-chain figure; feeding it back verbatim can trip the
    // vault's share round-up and revert. Take a buffer off it.
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
  // Note the asymmetry under test: we sign on `srcChainKey` (a spoke, possibly non-EVM) while
  // the shares — and `intent.srcChain` — are hub-side.
  const { created, txHash } = await buildSignSend(
    cfg,
    () =>
      postJson<CreateIntentResponse>(`${cfg.baseUrl}/intents/withdraw`, {
        vault: vault.vault,
        srcChainKey: cfg.srcChain.chainKey,
        srcAddress: cfg.signerAddress,
        dstChainKey: cfg.dstChainKey,
        outputToken: cfg.outputToken,
        inputAmount: shares.toString(),
        minOutputAmount: minOutputAmount.toString(),
        deadline: deadline.toString(),
        // NB: no `partnerFee` — leverage withdrawals have no such field (deposits do).
        // See icon-project/sodax-sdks#325.
      }),
    'withdraw',
  );

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

  const sharesAfter = await readSharesSoft(cfg, vault, hubWallet, 'shares remaining for');

  return {
    leg: 'withdraw',
    vaultName: vault.name,
    vaultAddress: vault.vault,
    srcChainKey: cfg.srcChain.chainKey,
    srcChainName: cfg.srcChain.name,
    srcChainKind: cfg.srcChain.kind,
    dstChainKey: cfg.dstChainKey,
    hubWallet,
    signerAddress: cfg.signerAddress,
    inputToken: vault.vault,
    inputAmount: shares.toString(),
    quotedAmount: quote.quotedAmount,
    minOutputAmount: minOutputAmount.toString(),
    deadline: deadline.toString(),
    txHash,
    ...intentFields(created),
    statusUrl: `${cfg.baseUrl}/submit-tx/status?txHash=${txHash}&srcChainKey=${cfg.srcChain.chainKey}`,
    submitResponse: submitted.response,
    relayDataForm: submitted.relayDataForm,
    finalStatus,
    sharesAfter,
    ...proof,
    elapsedMs: Date.now() - startMs,
  };
}

// ----------------------------------------------------------------------------
// READ-ONLY DISCOVERY (spends nothing)
// ----------------------------------------------------------------------------

async function runDiscovery(cfg: Config): Promise<void> {
  console.log(`\nLeverage Yield — read-only discovery (no funds spent)`);
  console.log(`Signer : ${cfg.signerAddress} (${cfg.srcChain.kind})`);
  console.log(`Source : ${cfg.srcChain.name} (${cfg.srcChain.chainKey})`);
  if (cfg.srcChain.kind === 'solana') {
    console.log(`EVM EOA: ${cfg.evmAddress} (same PRIVATE_KEY, unrelated address)`);
  }

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
  console.log(`  signer (srcAddress)         : ${cfg.signerAddress}`);
  console.log(`  share-balance               : ${shareBalance.balance}`);
  console.log(`  max-withdraw (RAW)          : ${maxWithdraw.maxWithdraw}`);

  console.log(`\n[4/5] POST /quote/withdraw`);
  const quoteWithdraw = (amount: bigint) =>
    postJson<QuoteResponse>(`${cfg.baseUrl}/quote/withdraw`, {
      vault: vault.vault,
      srcChainKey: cfg.srcChain.chainKey,
      tokenDst: cfg.outputToken,
      tokenDstChainKey: cfg.dstChainKey,
      amount: amount.toString(),
      quoteType: 'exact_input',
    });

  // Price the real position if there is one, else what the deposit above would mint. A residual
  // dust position is common (`max-withdraw` never lets a vault be fully exited) and too small to
  // route — the backend reports that as a flat "No path was found", so fall back to the
  // deposit-sized amount to show the route does exist. Read-only: never fatal.
  const positionShares = BigInt(shareBalance.balance);
  const mintedShares = BigInt(depositQuote.quotedAmount);
  const probes: { amount: bigint; label: string }[] =
    positionShares > 0n
      ? [
          { amount: positionShares, label: 'current position' },
          { amount: mintedShares, label: 'deposit-sized (position too small to route)' },
        ]
      : [{ amount: mintedShares, label: 'deposit-sized' }];

  for (const probe of probes) {
    try {
      const quote = await quoteWithdraw(probe.amount);
      console.log(
        `  ${probe.amount} ${vault.name} shares [${probe.label}] -> ${quote.quotedAmount} (${cfg.outputToken} on ${cfg.dstChainKey})`,
      );
      break;
    } catch (err) {
      console.log(`  ${probe.amount} [${probe.label}] failed: ${(err as Error).message}`);
    }
  }

  console.log(`\n[5/5] Negative test — malformed vault must be 400 (not a 502)`);
  const negative = await postRaw(`${cfg.baseUrl}/quote/deposit`, {
    vault: 'not-an-address',
    tokenSrc: cfg.inputToken,
    tokenSrcChainKey: cfg.srcChain.chainKey,
    amount: inputAmount.toString(),
    quoteType: 'exact_input',
  });
  console.log(`  HTTP ${negative.status}: ${negative.body}`);
  // This is an assertion, not a report: `--vaults` is documented as checking the 400 behaviour, so
  // a regression has to make the command exit non-zero or nothing watching it can tell the
  // difference. Throwing is safe here — it is the last step, so no earlier output is lost.
  if (negative.status !== 400) {
    throw new Error(
      `Negative test REGRESSED: a malformed vault returned ${negative.status}, expected 400. ` +
        `This previously surfaced as a misleading 502. Body: ${negative.body}`,
    );
  }
  console.log(`  PASS — rejected with 400`);
}

// ----------------------------------------------------------------------------
// PROOF REPORT
// ----------------------------------------------------------------------------

/**
 * The fields that make a non-EVM source distinctive, pulled out for the #1029 write-up: the
 * source spoke stays `solana` while the intent itself is hub-side (`srcChain` 146) and owned by
 * the derived hub wallet, and `packetData` carries the cross-chain delivery proof. Read
 * defensively — anything the response does not carry is reported as absent, not guessed.
 */
function divergenceLines(e: LegEvidence): string[] {
  const data = (e.finalStatus.data ?? {}) as Record<string, unknown>;
  // The status row carries no `intent`, so prefer what was captured off the create-intent
  // response and only fall back to the row if a future API version starts echoing it.
  const intent = (data.intent ?? {}) as Record<string, unknown>;
  // `packetData` sits under `result` in the swaps-api response shape, but has been seen at the
  // top level too — check both rather than silently reporting it absent.
  const result = (data.result ?? {}) as Record<string, unknown>;
  const packet = (data.packetData ?? result.packetData ?? {}) as Record<string, unknown>;
  const show = (v: unknown) => (v === undefined || v === null ? '(absent)' : String(v));

  return [
    ``,
    `Non-EVM source divergence (what this leg uniquely proves):`,
    ``,
    `| field | value |`,
    `|---|---|`,
    `| \`row.srcChainKey\` | \`${show(data.srcChainKey)}\` |`,
    `| \`intent.srcChain\` | \`${show(e.intentSrcChain ?? intent.srcChain)}\` (hub id, even though the tx was signed on Solana) |`,
    `| \`intent.srcAddress\` | \`${show(e.intentSrcAddress ?? intent.srcAddress)}\` |`,
    `| \`intent.creator\` | \`${show(e.intentCreator ?? intent.creator)}\` |`,
    `| \`relayData.address\` | \`${show(e.relayDataAddress ?? e.hubWallet)}\` |`,
    `| \`packetData.src_chain_id\` | \`${show(packet.src_chain_id)}\` |`,
    `| \`packetData.dst_chain_id\` | \`${show(packet.dst_chain_id)}\` |`,
    `| \`packetData.status\` | \`${show(packet.status)}\` |`,
    ``,
    `\`relayData\` was accepted as: **${e.relayDataForm}**. \`relayData.payload\` is only read by`,
    `the relay for non-EVM sources (EVM relays \`{chain_id, tx_hash}\` and ignores it), so this run`,
    `is the first to actually exercise it.`,
  ];
}

function proofBlock(e: LegEvidence): string {
  const lines = [
    `### ${e.leg === 'deposit' ? 'Deposit' : 'Withdraw'} from ${e.srcChainName} (${e.vaultName})`,
    ``,
    `- vault         : ${e.vaultAddress}`,
    `- srcChainKey   : ${e.srcChainKey} (${e.srcChainKind})`,
    ...(e.dstChainKey ? [`- dstChainKey   : ${e.dstChainKey}`] : []),
    `- source tx     : ${e.txHash}`,
    ...(e.approveTxHash ? [`- approve tx    : ${e.approveTxHash}`] : []),
    `- signer        : ${e.signerAddress}`,
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
    ...(e.srcChainKind === 'solana' ? divergenceLines(e) : []),
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
  --round-trip    Leg 1 then Leg 2 back to back. SPENDS REAL FUNDS.

The source spoke comes from LEVERAGE_SRC_CHAIN_KEY (default sonic). Set it to \`solana\` for
the non-EVM split-tx path — #1029's leg 3 — which signs ed25519 instead of secp256k1 and pays
out via the hub wallet. Remember hub wallets are PER SPOKE: shares deposited from one spoke
cannot be withdrawn from another, so a Solana withdraw needs a Solana deposit first.`;

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
  console.log(`Signer : ${cfg.signerAddress} (${cfg.srcChain.kind})`);
  console.log(`Source : ${cfg.srcChain.name} (${cfg.srcChain.chainKey})`);
  console.log(`Dest   : ${cfg.dstChain.name} (${cfg.dstChainKey})`);
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
