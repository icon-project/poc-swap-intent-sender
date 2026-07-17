import 'dotenv/config';
import { writeFileSync } from 'fs';
import { type Address, type Hex, parseUnits, formatUnits } from 'viem';
import { Sodax, type CreateIntentParams } from '@sodax/sdk';
import {
  getRequiredEnv,
  normalizePrivateKey,
  sleep,
  erc20Abi,
  unixNow,
  submitIntent,
  pollIntentStatus,
  pollIntentJournal,
  crossCheckIntentJournal,
  confirmIntentFilled,
  buildSubmitPayload,
  overwriteLine,
  formatElapsed,
} from './helpers';
import {
  type HopDef,
  CHAIN_DEFS,
  FORWARD_HOPS,
  RETURN_HOPS,
  REMOTE_CHAIN_KEYS,
  SONIC_USDT,
  NATIVE as NATIVE_ADDR,
  ViemWalletProvider,
  getNativeBalance,
  formatNativeBalance,
  getRpcUrl,
  getDisabledChains,
  buildEffectiveHops,
} from './sdk-helpers';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ----------------------------------------------------------------------------
// CONSTANTS
// ----------------------------------------------------------------------------

const NATIVE = '0x0000000000000000000000000000000000000000';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// Gas buffer: amount of native token to keep for gas on source chain
// Different chains have different gas costs, so we use conservative buffers
const GAS_BUFFERS: Record<string, bigint> = {
  base: parseUnits('0.0001', 18), // ETH (L2, very cheap gas)
  optimism: parseUnits('0.0001', 18), // ETH (L2, very cheap gas)
  arbitrum: parseUnits('0.0001', 18), // ETH (L2, very cheap gas)
  avalanche: parseUnits('0.01', 18), // AVAX
  bsc: parseUnits('0.001', 18), // BNB
  polygon: parseUnits('0.1', 18), // POL
  ethereum: parseUnits('0.001', 18), // ETH (L1, higher gas)
  hyper: parseUnits('0.01', 18), // HYPE
  lightlink: parseUnits('0.0001', 18), // ETH (cheap gas)
  redbelly: parseUnits('0.01', 18), // RBNT
  kaia: parseUnits('0.1', 18), // KAIA
};

// ----------------------------------------------------------------------------
// HOP RESULT TYPE
// ----------------------------------------------------------------------------

type HopResult = {
  hopIndex: number;
  label: string;
  txHash: string;
  intentId: string;
  intentHash?: string; // hub intent hash — used to cross-check the journal on a failed/timed-out hop
  inputAmount: string;
  status: 'executed' | 'failed' | 'timeout' | 'skipped';
  elapsedMs: number;
};

// Profiling extension of HopResult. The extra fields are only populated when a hop runs
// under `--profile`; all are optional so a plain HopResult is still a valid HopProfile
// (e.g. the failure-path results built in executeAllHops / main).
type HopProfile = HopResult & {
  createMs?: number; // SDK build + broadcast of the create-intent tx
  confirmMs?: number; // waitForTransactionReceipt on the source chain
  submitMs?: number; // POST /submit-tx round-trip
  // Phase name -> ms elapsed from the broadcast anchor (tBroadcast), per source.
  swapPhases?: Record<string, number>; // pending/relaying/relayed/posting_execution/posted_execution/solved/failed
  journalPhases?: Record<string, number>; // first-seen/filled/cancelled/closed
  swapExecutedMs?: number | null; // time-to-solved (terminal success) reported by swaps-api
  journalFilledMs?: number | null; // time-to-filled reported by the intent journal
  journalVsSwapDeltaMs?: number | null; // journalFilledMs - swapExecutedMs
};

// ----------------------------------------------------------------------------
// FLAG -> HOP MAPPING
// ----------------------------------------------------------------------------

const ALL_HOPS = [...FORWARD_HOPS, ...RETURN_HOPS];
const FLAG_TO_HOP: Record<string, HopDef | HopDef[]> = {
  '--all': FORWARD_HOPS,
};
for (const hop of ALL_HOPS) {
  FLAG_TO_HOP[`--${hop.id}`] = hop;
}

// ----------------------------------------------------------------------------
// SINGLE HOP EXECUTION
// ----------------------------------------------------------------------------

async function executeHop(
  sodax: Sodax,
  hop: HopDef,
  privateKey: Hex,
  hopIndex = 0,
  profile = false,
): Promise<HopProfile> {
  const hopStart = Date.now();
  const srcChain = CHAIN_DEFS[hop.srcChainKey];
  const dstChain = CHAIN_DEFS[hop.dstChainKey];
  if (!srcChain || !dstChain) {
    throw new Error(`Unknown chain key: ${hop.srcChainKey} or ${hop.dstChainKey}`);
  }

  const srcRpcUrl = getRpcUrl(srcChain);
  const walletProvider = new ViemWalletProvider(privateKey, srcChain.viemChain, srcRpcUrl);
  const walletAddress = await walletProvider.getWalletAddress();

  console.log(`  Wallet    : ${walletAddress}`);
  console.log(`  Source    : ${srcChain.name} (${srcChain.chainKey})`);
  console.log(`  Dest      : ${dstChain.name} (${dstChain.chainKey})`);

  // Determine input amount
  let inputAmount: bigint;
  let inputAmountDisplay = '';
  const isNativeInput = hop.inputToken.toLowerCase() === NATIVE.toLowerCase();

  if (isNativeInput) {
    const balance = await getNativeBalance(srcRpcUrl, srcChain.viemChain, walletAddress);
    console.log(`  Balance   : ${formatNativeBalance(balance, srcChain.nativeSymbol)}`);

    const gasBuffer = GAS_BUFFERS[hop.srcChainKey] ?? parseUnits('0.001', 18);

    // For native tokens, use full balance minus gas buffer (INPUT_AMOUNT_HUMAN only applies to ERC20)
    if (balance <= gasBuffer) {
      throw new Error(
        `Insufficient ${srcChain.nativeSymbol} balance: ${formatNativeBalance(balance, srcChain.nativeSymbol)}, ` +
          `need more than gas buffer ${formatNativeBalance(gasBuffer, srcChain.nativeSymbol)}`,
      );
    }
    inputAmount = balance - gasBuffer;
    inputAmountDisplay = `${formatNativeBalance(inputAmount, srcChain.nativeSymbol)}`;
    console.log(`  Input     : ${inputAmountDisplay} (balance - gas buffer)`);
  } else {
    // ERC20 input (first hop: USDT on Sonic)
    const publicClient = createPublicClient({
      chain: srcChain.viemChain,
      transport: http(srcRpcUrl),
    });

    const [balance, decimals, symbol] = await Promise.all([
      publicClient.readContract({
        address: hop.inputToken as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddress],
      }),
      publicClient.readContract({
        address: hop.inputToken as Address,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
      publicClient.readContract({
        address: hop.inputToken as Address,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
    ]);

    console.log(
      `  Balance   : ${formatUnits(balance, decimals)} ${symbol} (${balance.toString()} base)`,
    );

    const envHuman = process.env.INPUT_AMOUNT_HUMAN;
    const envBase = process.env.INPUT_AMOUNT;
    if (envBase && /^\d+$/.test(envBase)) {
      inputAmount = BigInt(envBase);
    } else {
      const human = envHuman || '1';
      inputAmount = parseUnits(human, decimals);
    }

    inputAmountDisplay = `${formatUnits(inputAmount, decimals)} ${symbol}`;
    console.log(`  Input     : ${inputAmountDisplay} (${inputAmount.toString()} base)`);

    if (balance < inputAmount) {
      throw new Error(
        `Insufficient ${symbol} balance: have ${balance.toString()}, need ${inputAmount.toString()}`,
      );
    }
  }

  // ERC20 approval for Sonic hub: the SDK's createSwapIntent sends tx directly
  // to the intents contract, which calls transferFrom on the ERC20.
  // The spender is the intents contract address.
  if (!isNativeInput && srcChain.chainKey === 'sonic') {
    const publicClient = createPublicClient({
      chain: srcChain.viemChain,
      transport: http(srcRpcUrl),
    });

    // Get the intents contract address from SDK config
    const { getSolverConfig } = await import('@sodax/types');
    const intentsContract = getSolverConfig().intentsContract as Address;
    console.log(`  Intents contract: ${intentsContract}`);

    const allowance = await publicClient.readContract({
      address: hop.inputToken as Address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [walletAddress, intentsContract],
    });
    console.log(`  Allowance : ${allowance.toString()} (spender: ${intentsContract})`);

    if (allowance < inputAmount) {
      console.log(`  Approving ${inputAmount.toString()} for ${intentsContract}...`);
      const account = privateKeyToAccount(privateKey);
      const walletClient = createWalletClient({
        account,
        chain: srcChain.viemChain,
        transport: http(srcRpcUrl),
      });
      const approveHash = await walletClient.writeContract({
        address: hop.inputToken as Address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [intentsContract, inputAmount],
      });
      console.log(`  Approve tx: ${approveHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log(`  Approval confirmed in block ${receipt.blockNumber}`);
      await sleep(2000);
    } else {
      console.log(`  Allowance sufficient`);
    }
  }

  // Build intent params (v2: chain KEYS, not chain ids)
  const deadline = unixNow() + 3600n;
  const intentParams: CreateIntentParams = {
    inputToken: hop.inputToken,
    outputToken: hop.outputToken,
    inputAmount,
    minOutputAmount: 0n,
    deadline,
    allowPartialFill: false,
    srcChainKey: srcChain.chainKey,
    dstChainKey: dstChain.chainKey,
    srcAddress: walletAddress.toLowerCase(),
    dstAddress: walletAddress.toLowerCase(),
    solver: ZERO_ADDRESS,
    data: '0x',
  };

  console.log(`  Intent params:`);
  console.log(`    inputToken     : ${intentParams.inputToken}`);
  console.log(`    outputToken    : ${intentParams.outputToken}`);
  console.log(`    inputAmount    : ${intentParams.inputAmount.toString()}`);
  console.log(`    minOutputAmount: ${intentParams.minOutputAmount.toString()}`);
  console.log(`    deadline       : ${intentParams.deadline.toString()}`);
  console.log(`    srcChainKey    : ${intentParams.srcChainKey}`);
  console.log(`    dstChainKey    : ${intentParams.dstChainKey}`);

  // Step 1: Create intent on-chain via SDK (broadcast mode — does NOT submit to solver).
  // v2: pass the wallet provider directly; the SDK resolves the spoke provider from srcChainKey.
  console.log(`\n  Creating intent on-chain via SDK...`);

  const tCreateStart = Date.now();
  const createResult = await sodax.swaps.createIntent({
    params: intentParams,
    // biome-ignore lint/suspicious/noExplicitAny: walletProvider is EVM; param type is the full chain-key union
    walletProvider: walletProvider as any,
  });

  if (!createResult.ok) {
    console.error(`  Intent creation failed!`);
    console.error(`  Error:`, createResult.error);
    throw new Error(
      `Intent creation failed: ${JSON.stringify(createResult.error, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  }

  const { tx: txHash, intent, relayData } = createResult.value;
  // Shared anchor for both status sources: the moment the create-intent tx is broadcast.
  const tBroadcast = Date.now();
  const createMs = tBroadcast - tCreateStart;
  console.log(`  Intent created on-chain!`);
  console.log(`  Tx hash   : ${txHash}`);
  console.log(`  Intent ID : ${intent.intentId.toString()}`);

  // Step 2: Wait for receipt confirmation
  console.log(`  Waiting for tx confirmation...`);
  const srcPublicClient = createPublicClient({
    chain: srcChain.viemChain,
    transport: http(srcRpcUrl),
  });
  const tConfirmStart = Date.now();
  const receipt = await srcPublicClient.waitForTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  const confirmMs = Date.now() - tConfirmStart;
  console.log(`  Confirmed in block ${receipt.blockNumber}`);

  // Step 3: Submit to the swaps backend
  const backendUrl = process.env.BACKEND_SWAP_ENDPOINT || 'https://api.sodax.com/v1/swaps';

  const payload = buildSubmitPayload(
    txHash as `0x${string}`,
    walletAddress,
    srcChain.chainKey,
    intent,
    relayData.payload,
  );

  console.log(`\n  Submitting to swaps...`);
  const tSubmitStart = Date.now();
  await submitIntent(payload, backendUrl);
  const submitMs = Date.now() - tSubmitStart;

  // Cross-chain hops broadcast on the spoke chain, so the journal (keyed by the hub tx) is
  // looked up by intentHash, not the spoke txHash. On-chain-derived → any deployment works;
  // default to the public gateway (`/v1/be` prefix).
  const apiBaseUrl = process.env.INTENT_API_ENDPOINT || 'https://api.sodax.com/v1/be';
  const intentHash = sodax.swaps.getIntentHash(intent);

  if (profile) {
    // PROFILE MODE: race the two status sources concurrently from the broadcast anchor so we
    // can measure how long EACH independently takes to report the intent filled. Both pollers
    // record per-phase transition timestamps relative to tBroadcast via onPhase.
    console.log(
      `\n  Profiling: racing swaps-api status vs intent journal from broadcast anchor...`,
    );
    const profileInterval = Number(process.env.PROFILE_POLL_INTERVAL_MS || '1500');
    const swapTimeout = Number(process.env.POLL_TIMEOUT_MS || '300000');
    const journalTimeout = Number(process.env.JOURNAL_PROFILE_TIMEOUT_MS || '300000');

    const swapPhases: Record<string, number> = {};
    const journalPhases: Record<string, number> = {};

    await Promise.allSettled([
      pollIntentStatus(
        txHash as string,
        backendUrl,
        profileInterval,
        swapTimeout,
        srcChain.chainKey,
        {
          anchorMs: tBroadcast,
          logPrefix: '[swap-api]',
          onPhase: (p, at) => {
            swapPhases[p] = at;
          },
        },
      ),
      pollIntentJournal(apiBaseUrl, { intentHash }, profileInterval, journalTimeout, {
        anchorMs: tBroadcast,
        logPrefix: '[journal] ',
        onPhase: (p, at) => {
          journalPhases[p] = at;
        },
      }),
    ]);

    // `solved` is the swaps-api terminal success phase (renamed from `executed` in a 2026 SODAX SDK rename).
    const swapExecutedMs = swapPhases.solved ?? null;
    const journalFilledMs = journalPhases.filled ?? null;
    const journalVsSwapDeltaMs =
      swapExecutedMs != null && journalFilledMs != null ? journalFilledMs - swapExecutedMs : null;

    const hopStatus: HopResult['status'] =
      swapExecutedMs != null ? 'executed' : swapPhases.failed != null ? 'failed' : 'timeout';

    const elapsedMs = Date.now() - hopStart;
    console.log(`  Elapsed: ${formatElapsed(hopStart)}`);
    if (swapExecutedMs != null) console.log(`  swaps-api executed at: ${swapExecutedMs}ms`);
    if (journalFilledMs != null) console.log(`  journal filled at:     ${journalFilledMs}ms`);
    if (journalVsSwapDeltaMs != null)
      console.log(
        `  journal vs swap-api:   ${journalVsSwapDeltaMs >= 0 ? '+' : ''}${journalVsSwapDeltaMs}ms`,
      );

    return {
      hopIndex,
      label: hop.label,
      txHash: txHash as string,
      intentId: intent.intentId.toString(),
      intentHash,
      inputAmount: inputAmountDisplay,
      status: hopStatus,
      elapsedMs,
      createMs,
      confirmMs,
      submitMs,
      swapPhases,
      journalPhases,
      swapExecutedMs,
      journalFilledMs,
      journalVsSwapDeltaMs,
    };
  }

  // DEFAULT MODE: PRIMARY status — poll the swaps-api submit-tx/status route (keyed by the
  // source-chain txHash + srcChainKey), then a single soft journal cross-check.
  console.log(`\n  Polling swaps-api submit-tx/status...`);
  const pollInterval = Number(process.env.POLL_INTERVAL_MS || '3000');
  const pollTimeout = Number(process.env.POLL_TIMEOUT_MS || '120000');

  let hopStatus: 'executed' | 'failed' | 'timeout' = 'timeout';
  try {
    const result = await pollIntentStatus(
      txHash as string,
      backendUrl,
      pollInterval,
      pollTimeout,
      srcChain.chainKey,
    );
    const s = (result?.data as Record<string, unknown> | undefined)?.status;
    // `solved` is the swaps-api terminal success state (renamed from `executed` in a 2026 SODAX SDK rename).
    hopStatus = s === 'solved' ? 'executed' : 'failed';
  } catch {
    hopStatus = 'timeout';
  }

  // Independent on-chain confirmation via the intent journal (soft, never fatal).
  const crossCheckTimeout = Number(process.env.JOURNAL_CROSSCHECK_TIMEOUT_MS || '90000');
  await crossCheckIntentJournal(apiBaseUrl, { intentHash }, pollInterval, crossCheckTimeout);

  const elapsedMs = Date.now() - hopStart;
  console.log(`  Elapsed: ${formatElapsed(hopStart)}`);

  return {
    hopIndex,
    label: hop.label,
    txHash: txHash as string,
    intentId: intent.intentId.toString(),
    intentHash,
    inputAmount: inputAmountDisplay,
    status: hopStatus,
    elapsedMs,
  };
}

// ----------------------------------------------------------------------------
// SUMMARY HELPERS
// ----------------------------------------------------------------------------

function formatMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem.toString().padStart(2, '0')}s`;
}

function buildSummaryText(results: HopResult[]): string {
  const sep = '='.repeat(80);
  const divider = '-'.repeat(80);
  const lines: string[] = [sep, 'CHAIN HOP SUMMARY', sep];

  for (const r of results) {
    lines.push(`#${r.hopIndex}  ${r.label}`);
    lines.push(`    Status: ${r.status} | Elapsed: ${formatMs(r.elapsedMs)}`);
    if (r.inputAmount) lines.push(`    Input: ${r.inputAmount}`);
    lines.push(`    Tx: ${r.txHash || 'N/A'}`);
    lines.push(divider);
  }

  const totalMs = results.reduce((sum, r) => sum + r.elapsedMs, 0);
  const executed = results.filter((r) => r.status === 'executed').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'timeout').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  lines.push(`Total elapsed: ${formatMs(totalMs)}`);
  lines.push(`Executed: ${executed} | Failed: ${failed} | Skipped: ${skipped}`);
  lines.push(sep);

  return lines.join('\n');
}

function saveSummary(text: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `chain-hop-summary-${ts}.txt`;
  writeFileSync(filename, text + '\n', 'utf-8');
  return filename;
}

// ----------------------------------------------------------------------------
// PROFILE REPORTS (--profile)
// ----------------------------------------------------------------------------

const SWAP_PHASE_ORDER = [
  'pending',
  'relaying',
  'relayed',
  'posting_execution',
  'posted_execution',
  'solved', // terminal success (renamed from `executed` in a 2026 SODAX SDK rename)
  'failed',
];
const JOURNAL_PHASE_ORDER = ['first-seen', 'filled', 'cancelled', 'closed'];

function statRange(xs: number[]): string {
  if (xs.length === 0) return 'n/a';
  const avg = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return `min ${Math.min(...xs)}ms / avg ${avg}ms / max ${Math.max(...xs)}ms`;
}

function buildProfileText(results: HopProfile[]): string {
  const sep = '='.repeat(80);
  const divider = '-'.repeat(80);
  const lines: string[] = [sep, 'CHAIN HOP TIMING PROFILE', sep];

  for (const r of results) {
    lines.push(`#${r.hopIndex}  ${r.label}`);
    lines.push(
      `    Status: ${r.status} | Wall: ${formatMs(r.elapsedMs)} | Tx: ${r.txHash || 'N/A'}`,
    );
    if (r.createMs != null) {
      lines.push(
        `    Steps : create ${r.createMs}ms | confirm ${r.confirmMs}ms | submit ${r.submitMs}ms`,
      );
    }
    const sp = r.swapPhases ?? {};
    const swapStr = SWAP_PHASE_ORDER.filter((p) => sp[p] != null)
      .map((p) => `${p}=${sp[p]}ms`)
      .join(', ');
    lines.push(`    swap-api : ${swapStr || '(no phases recorded)'}`);
    const jp = r.journalPhases ?? {};
    const jStr = JOURNAL_PHASE_ORDER.filter((p) => jp[p] != null)
      .map((p) => `${p}=${jp[p]}ms`)
      .join(', ');
    lines.push(`    journal  : ${jStr || '(no phases recorded)'}`);
    if (r.swapExecutedMs != null || r.journalFilledMs != null) {
      const d = r.journalVsSwapDeltaMs;
      lines.push(
        `    filled   : swap-api ${r.swapExecutedMs ?? 'n/a'}ms vs journal ${r.journalFilledMs ?? 'n/a'}ms` +
          (d != null ? ` (journal ${d >= 0 ? '+' : ''}${d}ms)` : ''),
      );
    }
    lines.push(divider);
  }

  const swapTimes = results.map((r) => r.swapExecutedMs).filter((v): v is number => v != null);
  const journalTimes = results.map((r) => r.journalFilledMs).filter((v): v is number => v != null);
  const deltas = results.map((r) => r.journalVsSwapDeltaMs).filter((v): v is number => v != null);

  lines.push('AGGREGATE (across hops reporting a fill on that source)');
  lines.push(`  swap-api time-to-executed: ${statRange(swapTimes)}  (n=${swapTimes.length})`);
  lines.push(`  journal  time-to-filled  : ${statRange(journalTimes)}  (n=${journalTimes.length})`);
  lines.push(`  journal - swap-api delta : ${statRange(deltas)}  (n=${deltas.length})`);
  const totalMs = results.reduce((s, r) => s + r.elapsedMs, 0);
  const executed = results.filter((r) => r.status === 'executed').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'timeout').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  lines.push(
    `  Total wall-clock: ${formatMs(totalMs)} | Executed: ${executed} | Failed: ${failed} | Skipped: ${skipped}`,
  );
  lines.push(sep);
  return lines.join('\n');
}

function buildProfileCsv(results: HopProfile[]): string {
  const header = [
    'hopIndex',
    'label',
    'status',
    'createMs',
    'confirmMs',
    'submitMs',
    'swap_pending',
    'swap_relaying',
    'swap_relayed',
    'swap_posting_execution',
    'swap_posted_execution',
    'swap_solved',
    'journal_first_seen',
    'journal_filled',
    'journalVsSwapDeltaMs',
  ];
  const cell = (v: number | null | undefined) => (v == null ? '' : String(v));
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = results.map((r) => {
    const sp = r.swapPhases ?? {};
    const jp = r.journalPhases ?? {};
    return [
      String(r.hopIndex),
      esc(r.label),
      r.status,
      cell(r.createMs),
      cell(r.confirmMs),
      cell(r.submitMs),
      cell(sp.pending),
      cell(sp.relaying),
      cell(sp.relayed),
      cell(sp.posting_execution),
      cell(sp.posted_execution),
      cell(sp.solved),
      cell(jp['first-seen']),
      cell(jp.filled),
      cell(r.journalVsSwapDeltaMs),
    ].join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

function saveProfileReports(results: HopProfile[]): { txt: string; json: string; csv: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `chain-hop-profile-${ts}`;
  const files = { txt: `${base}.txt`, json: `${base}.json`, csv: `${base}.csv` };

  const swapTimes = results.map((r) => r.swapExecutedMs).filter((v): v is number => v != null);
  const journalTimes = results.map((r) => r.journalFilledMs).filter((v): v is number => v != null);
  const deltas = results.map((r) => r.journalVsSwapDeltaMs).filter((v): v is number => v != null);
  const agg = (xs: number[]) =>
    xs.length === 0
      ? null
      : {
          n: xs.length,
          min: Math.min(...xs),
          max: Math.max(...xs),
          avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
        };

  const payload = {
    generatedAt: new Date().toISOString(),
    hops: results,
    aggregate: {
      swapExecutedMs: agg(swapTimes),
      journalFilledMs: agg(journalTimes),
      journalVsSwapDeltaMs: agg(deltas),
      totalWallMs: results.reduce((s, r) => s + r.elapsedMs, 0),
    },
  };

  writeFileSync(files.txt, buildProfileText(results) + '\n', 'utf-8');
  writeFileSync(files.json, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  writeFileSync(files.csv, buildProfileCsv(results) + '\n', 'utf-8');
  return files;
}

// ----------------------------------------------------------------------------
// AD-HOC HOP BUILDER
// ----------------------------------------------------------------------------

function buildHop(srcKey: string, dstKey: string): HopDef {
  const src = CHAIN_DEFS[srcKey];
  const dst = CHAIN_DEFS[dstKey];
  const inputToken = srcKey === 'sonic' ? SONIC_USDT : NATIVE_ADDR;
  const outputToken = dstKey === 'sonic' ? SONIC_USDT : NATIVE_ADDR;
  return {
    id: `${srcKey}-to-${dstKey}`,
    label: `${srcKey === 'sonic' ? 'USDT' : src.nativeSymbol}(${src.name}) → ${dstKey === 'sonic' ? 'USDT' : dst.nativeSymbol}(${dst.name})`,
    srcChainKey: srcKey,
    dstChainKey: dstKey,
    inputToken,
    outputToken,
  };
}

// ----------------------------------------------------------------------------
// ALL HOPS EXECUTION
// ----------------------------------------------------------------------------

/**
 * Wait until the destination chain holds enough native token to fund the NEXT hop (i.e. more
 * than its gas buffer). Runs whenever we advance `currentChain` — after a normal success AND
 * after the failure-path guard treats a hop as settled (notably journal-only fills, where the
 * hub->spoke native delivery can lag the fill by minutes). Uses an absolute `> gasBuffer`
 * threshold on purpose: here we only care whether there's enough to proceed, not which hop
 * delivered it. Never throws — a timeout logs and proceeds (the next hop re-checks its balance).
 */
async function waitForArrival(dstKey: string, walletAddress: Address): Promise<void> {
  const dstChain = CHAIN_DEFS[dstKey];
  const dstRpcUrl = getRpcUrl(dstChain);
  const nextGasBuffer = GAS_BUFFERS[dstKey] ?? parseUnits('0.001', 18);
  const balanceBefore = await getNativeBalance(dstRpcUrl, dstChain.viemChain, walletAddress);
  console.log(
    `\n  ${dstChain.name} balance: ${formatNativeBalance(balanceBefore, dstChain.nativeSymbol)} ` +
      `(need > ${formatNativeBalance(nextGasBuffer, dstChain.nativeSymbol)} to hop)`,
  );

  if (balanceBefore > nextGasBuffer) {
    console.log(`  Already funded above gas buffer, proceeding to next hop.`);
    return;
  }
  console.log(`  Waiting for ${dstChain.nativeSymbol} to arrive on ${dstChain.name}...`);

  const pollInterval = 10_000;
  // Hub->spoke native delivery can lag well past the swap-status timeout (some legs take
  // >5 min), so give arrival its own, more generous budget.
  const pollTimeout = Number(process.env.ARRIVAL_TIMEOUT_MS || '900000');
  const deadline = Date.now() + pollTimeout;

  let balanceInPlace = false;
  let funded = false;
  while (Date.now() < deadline) {
    await sleep(pollInterval);
    const balance = await getNativeBalance(dstRpcUrl, dstChain.viemChain, walletAddress);
    if (balance > nextGasBuffer) {
      if (balanceInPlace) process.stdout.write('\n');
      console.log(
        `  Balance now ${formatNativeBalance(balance, dstChain.nativeSymbol)}, proceeding to next hop.`,
      );
      funded = true;
      break;
    }
    overwriteLine(
      `  ${dstChain.name} balance: ${formatNativeBalance(balance, dstChain.nativeSymbol)} (waiting...)`,
    );
    balanceInPlace = true;
  }
  if (!funded) {
    if (balanceInPlace) process.stdout.write('\n');
    console.log(
      `  Timed out waiting for funds on ${dstChain.name}; proceeding anyway (next hop re-checks).`,
    );
  }
}

async function executeAllHops(
  sodax: Sodax,
  privateKey: Hex,
  startChain?: string,
  profile = false,
): Promise<void> {
  const disabled = getDisabledChains();
  const effectiveHops = buildEffectiveHops(FORWARD_HOPS, disabled);

  if (effectiveHops.length === 0) {
    console.log('No hops to execute (all chains disabled).');
    return;
  }

  // Extract ordered destination sequence and starting chain
  let destinations: string[] = effectiveHops.map((h) => h.dstChainKey);
  let currentChain = effectiveHops[0].srcChainKey;

  // Resume mid-sequence: --from <chainKey> drops every leg up to and including the
  // start chain, then continues with the normal rewire logic from there.
  if (startChain && startChain !== currentChain) {
    const idx = destinations.indexOf(startChain);
    if (idx === -1) {
      throw new Error(
        `--from chain '${startChain}' is not in the effective sequence ` +
          `(${[currentChain, ...destinations].join(' -> ')})`,
      );
    }
    currentChain = startChain;
    destinations = destinations.slice(idx + 1);
    console.log(`Resuming from ${CHAIN_DEFS[currentChain].name} (--from ${startChain})`);
  }

  if (disabled.size > 0) {
    console.log(`Effective destination sequence (${destinations.length} destinations):`);
    console.log(`  Start: ${CHAIN_DEFS[currentChain].name}`);
    for (const dst of destinations) {
      console.log(`  → ${CHAIN_DEFS[dst].name}`);
    }
  }

  const results: HopProfile[] = [];

  // Same EVM address on every chain — derive once for balance reads across the loop.
  const walletAddress = (await new ViemWalletProvider(
    privateKey,
    CHAIN_DEFS['sonic'].viemChain,
    getRpcUrl(CHAIN_DEFS['sonic']),
  ).getWalletAddress()) as Address;

  for (let i = 0; i < destinations.length; i++) {
    const dstKey = destinations[i];

    // Build hop dynamically from wherever funds actually are
    const hop = buildHop(currentChain, dstKey);
    const hopNum = i + 1;

    // Snapshot the destination's native balance BEFORE the hop runs. If the hop reports a
    // failure/timeout, the guard below treats funds as "arrived" only when the balance rose
    // above this baseline — a real delta from THIS hop — so pre-existing dust / prefunded gas /
    // a prior run can't be misread as a settled hop.
    const dstChain = CHAIN_DEFS[dstKey];
    const dstBalanceBefore = await getNativeBalance(
      getRpcUrl(dstChain),
      dstChain.viemChain,
      walletAddress,
    );

    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== Hop ${hopNum}/${destinations.length}: ${hop.label} ===`);
    console.log(`${'='.repeat(60)}`);

    // If the hop was rewired (source differs from original), note it
    const originalSrc =
      i === 0 ? effectiveHops[0].srcChainKey : (effectiveHops[i - 1]?.dstChainKey ?? currentChain);
    if (currentChain !== originalSrc) {
      console.log(
        `  (rewired: funds are on ${CHAIN_DEFS[currentChain].name}, skipping failed intermediate)`,
      );
    }

    let result: HopProfile;
    try {
      result = await executeHop(sodax, hop, privateKey, hopNum, profile);
    } catch (err: any) {
      console.error(`  Hop failed: ${err.message}`);
      result = {
        hopIndex: hopNum,
        label: hop.label,
        txHash: '',
        intentId: '',
        inputAmount: '',
        status: 'failed',
        elapsedMs: 0,
      };
    }

    let advanced = result.status === 'executed';

    if (!advanced) {
      // A reported failure/timeout is NOT proof the swap didn't fill: the status poll can give
      // up before the fill lands (hub->spoke delivery lags), or misreport. Before assuming the
      // funds stayed on the source chain and rewiring around this hop, verify against
      // independent on-chain signals — did THIS intent settle in the journal, and/or did native
      // funds actually arrive on the destination? If so, treat the hop as settled and advance.
      const apiBaseUrl = process.env.INTENT_API_ENDPOINT || 'https://api.sodax.com/v1/be';
      const dstRpcUrl = getRpcUrl(dstChain);

      console.log(
        `  Reported "${result.status}" — cross-checking journal + ${dstChain.name} balance before rewiring...`,
      );
      // Journal is authoritative for THIS exact intent. The balance signal must be a real
      // DELTA vs the pre-hop snapshot (funds increased during this hop) — an absolute
      // "> gas buffer" test would treat pre-existing dust / prefunded gas / prior-run funds
      // as this hop's arrival and wrongly advance.
      const journalFilled = result.intentHash
        ? await confirmIntentFilled(apiBaseUrl, { intentHash: result.intentHash })
        : false;
      const dstBalanceNow = await getNativeBalance(dstRpcUrl, dstChain.viemChain, walletAddress);
      const fundsArrived = dstBalanceNow > dstBalanceBefore;

      if (journalFilled || fundsArrived) {
        const why = journalFilled
          ? 'journal shows intent-filled'
          : `${dstChain.name} balance rose ${formatNativeBalance(dstBalanceBefore, dstChain.nativeSymbol)} -> ${formatNativeBalance(dstBalanceNow, dstChain.nativeSymbol)}`;
        console.log(
          `  On-chain signals say the hop settled (${why}) — advancing to ${dstChain.name}.`,
        );
        result.status = 'executed';
        advanced = true;
      } else {
        console.log(
          `  Confirmed funds did NOT move (journal not filled; ${dstChain.name} balance ` +
            `unchanged at ${formatNativeBalance(dstBalanceNow, dstChain.nativeSymbol)}). ` +
            `Funds remain on ${CHAIN_DEFS[currentChain].name}, will rewire next hop.`,
        );
      }
    }

    if (advanced) {
      // Funds moved to the destination — make it the source for the next hop, then wait for the
      // native balance to actually arrive. This runs for BOTH a normal success and a
      // guard-confirmed settle: on a journal-only fill the hub->spoke delivery may still be in
      // flight, and without this the next hop would start from an unfunded chain.
      currentChain = dstKey;
      if (i < destinations.length - 1) {
        await waitForArrival(dstKey, walletAddress);
      }
    }

    results.push(result);
  }

  // Print and save summary
  if (profile) {
    const report = buildProfileText(results);
    console.log(`\n${report}`);
    const files = saveProfileReports(results);
    console.log(`\nProfile saved to ${files.txt}, ${files.json}, ${files.csv}`);
  } else {
    const summary = buildSummaryText(results);
    console.log(`\n${summary}`);
    const file = saveSummary(summary);
    console.log(`\nSummary saved to ${file}`);
  }
}

// ----------------------------------------------------------------------------
// BALANCES
// ----------------------------------------------------------------------------

async function showBalances(privateKey: Hex): Promise<void> {
  const disabled = getDisabledChains();

  // Derive address from any chain (same key = same address)
  const sonicDef = CHAIN_DEFS['sonic'];
  const wp = new ViemWalletProvider(privateKey, sonicDef.viemChain, getRpcUrl(sonicDef));
  const walletAddress = await wp.getWalletAddress();
  console.log(`Wallet: ${walletAddress}\n`);

  // Sonic USDT balance
  const sonicRpc = getRpcUrl(sonicDef);
  const sonicPublic = createPublicClient({
    chain: sonicDef.viemChain,
    transport: http(sonicRpc),
  });
  const [usdtBalance, sonicNative] = await Promise.all([
    sonicPublic.readContract({
      address: SONIC_USDT as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletAddress],
    }),
    getNativeBalance(sonicRpc, sonicDef.viemChain, walletAddress),
  ]);
  console.log(
    `  Sonic       : ${formatUnits(usdtBalance, 6)} USDT  |  ${formatNativeBalance(sonicNative, 'S')}`,
  );

  // Remote chain native balances
  for (const key of REMOTE_CHAIN_KEYS) {
    if (disabled.has(key)) {
      const chain = CHAIN_DEFS[key];
      const pad = (chain.name + ' ').padEnd(12);
      console.log(`  ${pad}: DISABLED`);
      continue;
    }
    const chain = CHAIN_DEFS[key];
    const rpc = getRpcUrl(chain);
    try {
      const balance = await getNativeBalance(rpc, chain.viemChain, walletAddress);
      const pad = (chain.name + ' ').padEnd(12);
      console.log(`  ${pad}: ${formatNativeBalance(balance, chain.nativeSymbol)}`);
    } catch (err: any) {
      const pad = (chain.name + ' ').padEnd(12);
      console.log(`  ${pad}: ERROR - ${err.shortMessage || err.message}`);
    }
  }
}

// ----------------------------------------------------------------------------
// SWEEP — swap all remote native balances back to USDT on Sonic
// ----------------------------------------------------------------------------

async function sweep(sodax: Sodax, privateKey: Hex): Promise<void> {
  const disabled = getDisabledChains();
  const sonicDef = CHAIN_DEFS['sonic'];
  const wp = new ViemWalletProvider(privateKey, sonicDef.viemChain, getRpcUrl(sonicDef));
  const walletAddress = await wp.getWalletAddress();
  console.log(`Wallet: ${walletAddress}\n`);

  let swapped = 0;
  let skipped = 0;

  for (const key of REMOTE_CHAIN_KEYS) {
    if (disabled.has(key)) {
      console.log(`  ${CHAIN_DEFS[key].name}: DISABLED — skipping`);
      skipped++;
      continue;
    }
    const chain = CHAIN_DEFS[key];
    const rpc = getRpcUrl(chain);
    const gasBuffer = GAS_BUFFERS[key] ?? parseUnits('0.001', 18);

    let balance: bigint;
    try {
      balance = await getNativeBalance(rpc, chain.viemChain, walletAddress);
    } catch (err: any) {
      console.log(`  ${chain.name}: ERROR reading balance — ${err.shortMessage || err.message}`);
      continue;
    }

    if (balance <= gasBuffer) {
      console.log(
        `  ${chain.name}: ${formatNativeBalance(balance, chain.nativeSymbol)} — skipping (below gas buffer)`,
      );
      skipped++;
      continue;
    }

    const inputAmount = balance - gasBuffer;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== Sweep: ${chain.nativeSymbol}(${chain.name}) → USDT(Sonic) ===`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Balance   : ${formatNativeBalance(balance, chain.nativeSymbol)}`);
    console.log(
      `  Sweeping  : ${formatNativeBalance(inputAmount, chain.nativeSymbol)} (balance - gas buffer)`,
    );

    // Find or build the return hop
    const returnHop: HopDef = {
      id: `${key}-to-sonic`,
      label: `${chain.nativeSymbol}(${chain.name}) → USDT(Sonic)`,
      srcChainKey: key,
      dstChainKey: 'sonic',
      inputToken: NATIVE_ADDR,
      outputToken: SONIC_USDT,
    };

    const sweepStart = Date.now();
    try {
      await executeHop(sodax, returnHop, privateKey);
      swapped++;
      console.log(`  Sweep hop elapsed: ${formatElapsed(sweepStart)}`);
    } catch (err: any) {
      console.error(`  Sweep failed for ${chain.name}: ${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Sweep complete: ${swapped} swapped, ${skipped} skipped`);
  console.log(`${'='.repeat(60)}`);
}

// ----------------------------------------------------------------------------
// USAGE
// ----------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage: tsx chain-hop.ts <flag>\n`);
  console.log(`Utilities:`);
  console.log(`  --balances               Show native balance on every chain`);
  console.log(`  --sweep                  Swap all remote native balances back to USDT on Sonic\n`);
  console.log(`Full chain:`);
  console.log(
    `  --all                    Run all ${FORWARD_HOPS.length} forward hops sequentially\n`,
  );
  console.log(`Forward hops:`);
  for (const hop of FORWARD_HOPS) {
    console.log(`  --${hop.id.padEnd(25)} ${hop.label}`);
  }
  console.log(`\nReturn hops (back to USDT on Sonic):`);
  for (const hop of RETURN_HOPS) {
    console.log(`  --${hop.id.padEnd(25)} ${hop.label}`);
  }
  console.log(`\nModifiers (combine with any hop flag):`);
  console.log(
    `  --profile                Race swaps-api vs intent-journal status concurrently and write timing reports`,
  );
  console.log(`\nEnv vars (all optional):`);
  console.log(`  PRIVATE_KEY              Wallet private key (required)`);
  console.log(`  INPUT_AMOUNT_HUMAN       Input amount (default: use full balance for native)`);
  console.log(
    `  POLL_TIMEOUT_MS          SDK swap timeout (default: 120000; 300000 under --profile)`,
  );
  console.log(`  PROFILE_POLL_INTERVAL_MS Profile-mode poll interval (default: 1500)`);
  console.log(`  JOURNAL_PROFILE_TIMEOUT_MS Profile-mode journal timeout (default: 300000)`);
  console.log(`  <CHAIN>_RPC_URL          RPC override per chain (e.g., BASE_RPC_URL)`);
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  // `--profile` may appear anywhere; strip it so it composes with --all / single hops / --from.
  const rawArgs = process.argv.slice(2);
  const profile = rawArgs.includes('--profile');
  const args = rawArgs.filter((a) => a !== '--profile');
  const flag = args[0];
  const SPECIAL_FLAGS = new Set(['--balances', '--sweep']);

  if (!flag || (!FLAG_TO_HOP[flag] && !SPECIAL_FLAGS.has(flag))) {
    printUsage();
    if (!flag) process.exit(0);
    console.error(`\nUnknown flag: ${flag}`);
    process.exit(1);
  }

  const privateKey = normalizePrivateKey(getRequiredEnv('PRIVATE_KEY'));

  if (flag === '--balances') {
    await showBalances(privateKey);
    return;
  }

  const sodax = new Sodax();

  if (flag === '--sweep') {
    await sweep(sodax, privateKey);
    return;
  }

  const target = FLAG_TO_HOP[flag];

  if (Array.isArray(target)) {
    // Optional `--from <chainKey>` (or `--from=<chainKey>`) to resume mid-sequence.
    const rest = args.slice(1);
    let startChain: string | undefined;
    const fromEq = rest.find((a) => a.startsWith('--from='));
    if (fromEq) startChain = fromEq.slice('--from='.length);
    const fromIdx = rest.indexOf('--from');
    if (fromIdx !== -1 && rest[fromIdx + 1]) startChain = rest[fromIdx + 1];
    await executeAllHops(sodax, privateKey, startChain, profile);
  } else {
    // Check if src or dst chain is disabled
    const disabled = getDisabledChains();
    if (disabled.has(target.srcChainKey)) {
      console.log(`Skipping hop: chain '${target.srcChainKey}' is disabled via DISABLED_CHAINS`);
      return;
    }
    if (disabled.has(target.dstChainKey)) {
      console.log(`Skipping hop: chain '${target.dstChainKey}' is disabled via DISABLED_CHAINS`);
      return;
    }

    console.log(`\n=== ${target.label} ===`);
    let result: HopProfile;
    try {
      result = await executeHop(sodax, target, privateKey, 1, profile);
    } catch (err: any) {
      console.error(`\nHop failed: ${err.message}`);
      result = {
        hopIndex: 1,
        label: target.label,
        txHash: '',
        intentId: '',
        inputAmount: '',
        status: 'failed',
        elapsedMs: 0,
      };
    }
    if (profile) {
      const report = buildProfileText([result]);
      console.log(`\n${report}`);
      const files = saveProfileReports([result]);
      console.log(`\nProfile saved to ${files.txt}, ${files.json}, ${files.csv}`);
    } else {
      const summary = buildSummaryText([result]);
      console.log(`\n${summary}`);
      const file = saveSummary(summary);
      console.log(`\nSummary saved to ${file}`);
    }
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
