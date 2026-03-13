import 'dotenv/config';
import { writeFileSync } from 'fs';
import { type Address, type Hex, parseUnits, formatUnits } from 'viem';
import { Sodax, type CreateIntentParams } from '@sodax/sdk';
import type { SpokeChainId } from '@sodax/types';
import {
  getRequiredEnv,
  normalizePrivateKey,
  sleep,
  erc20Abi,
  unixNow,
  submitIntent,
  pollIntentStatus,
  overwriteLine,
  formatElapsed,
  type SubmitTxPayload,
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
  createSpokeProvider,
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
  ethereum: parseUnits('0.005', 18), // ETH (L1, higher gas)
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
  inputAmount: string;
  status: 'executed' | 'failed' | 'timeout';
  elapsedMs: number;
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
): Promise<HopResult> {
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
  console.log(`  Source    : ${srcChain.name} (${srcChain.spokeChainId})`);
  console.log(`  Dest      : ${dstChain.name} (${dstChain.spokeChainId})`);

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
  if (!isNativeInput && srcChain.spokeChainId === 'sonic') {
    const publicClient = createPublicClient({
      chain: srcChain.viemChain,
      transport: http(srcRpcUrl),
    });

    // Get the intents contract address from SDK config
    const { getSolverConfig } = await import('@sodax/types');
    const intentsContract = getSolverConfig('sonic').intentsContract as Address;
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

  // Build intent params
  const deadline = unixNow() + 3600n;
  const intentParams: CreateIntentParams = {
    inputToken: hop.inputToken,
    outputToken: hop.outputToken,
    inputAmount,
    minOutputAmount: 0n,
    deadline,
    allowPartialFill: false,
    srcChain: srcChain.spokeChainId as SpokeChainId,
    dstChain: dstChain.spokeChainId as SpokeChainId,
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
  console.log(`    srcChain       : ${intentParams.srcChain}`);
  console.log(`    dstChain       : ${intentParams.dstChain}`);

  // Create spoke provider for source chain
  const spokeProvider = createSpokeProvider(srcChain, walletProvider);

  // Step 1: Create intent on-chain via SDK (does NOT submit to solver)
  console.log(`\n  Creating intent on-chain via SDK...`);

  const createResult = await sodax.swaps.createIntent({
    intentParams,
    spokeProvider: spokeProvider as any,
    raw: false,
  });

  if (!createResult.ok) {
    console.error(`  Intent creation failed!`);
    console.error(`  Error:`, createResult.error);
    throw new Error(`Intent creation failed: ${JSON.stringify(createResult.error, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  }

  const [txHash, intent, relayData] = createResult.value;
  console.log(`  Intent created on-chain!`);
  console.log(`  Tx hash   : ${txHash}`);
  console.log(`  Intent ID : ${intent.intentId.toString()}`);

  // Step 2: Wait for receipt confirmation
  console.log(`  Waiting for tx confirmation...`);
  const srcPublicClient = createPublicClient({
    chain: srcChain.viemChain,
    transport: http(srcRpcUrl),
  });
  const receipt = await srcPublicClient.waitForTransactionReceipt({
    hash: txHash as `0x${string}`,
  });
  console.log(`  Confirmed in block ${receipt.blockNumber}`);

  // Step 3: Submit to BES backend
  const backendUrl =
    process.env.BACKEND_SWAP_ENDPOINT || 'https://canary-api.sodax.com/v1/bes/swaps';

  const payload: SubmitTxPayload = {
    txHash: txHash as `0x${string}`,
    srcChainId: srcChain.spokeChainId,
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

  console.log(`\n  Submitting to BES...`);
  await submitIntent(payload, backendUrl);

  // Step 4: Poll BES for status
  console.log(`\n  Polling BES for status...`);
  const pollInterval = Number(process.env.POLL_INTERVAL_MS || '3000');
  const pollTimeout = Number(process.env.POLL_TIMEOUT_MS || '120000');

  let hopStatus: 'executed' | 'failed' | 'timeout' = 'timeout';
  try {
    const pollResult = await pollIntentStatus(
      txHash as string,
      backendUrl,
      pollInterval,
      pollTimeout,
      srcChain.spokeChainId,
    );
    const s = (pollResult?.data as Record<string, unknown> | undefined)?.status;
    hopStatus = s === 'executed' ? 'executed' : 'failed';
  } catch {
    hopStatus = 'timeout';
  }

  const elapsedMs = Date.now() - hopStart;
  console.log(`  Elapsed: ${formatElapsed(hopStart)}`);

  return {
    hopIndex,
    label: hop.label,
    txHash: txHash as string,
    intentId: intent.intentId.toString(),
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
  lines.push(`Total elapsed: ${formatMs(totalMs)}`);
  lines.push(`Executed: ${results.filter((r) => r.status === 'executed').length}/${results.length}`);
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
// ALL HOPS EXECUTION
// ----------------------------------------------------------------------------

async function executeAllHops(sodax: Sodax, privateKey: Hex): Promise<void> {
  const disabled = getDisabledChains();
  const effectiveHops = buildEffectiveHops(FORWARD_HOPS, disabled);

  if (effectiveHops.length === 0) {
    console.log('No hops to execute (all chains disabled).');
    return;
  }

  if (disabled.size > 0) {
    console.log(`Effective hop sequence (${effectiveHops.length} hops):`);
    for (const hop of effectiveHops) {
      console.log(`  ${hop.label}`);
    }
  }

  const results: HopResult[] = [];

  for (let i = 0; i < effectiveHops.length; i++) {
    const hop = effectiveHops[i];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== Hop ${i + 1}/${effectiveHops.length}: ${hop.label} ===`);
    console.log(`${'='.repeat(60)}`);

    let result: HopResult;
    try {
      result = await executeHop(sodax, hop, privateKey, i + 1);
    } catch (err: any) {
      console.error(`  Hop failed: ${err.message}`);
      result = {
        hopIndex: i + 1,
        label: hop.label,
        txHash: '',
        intentId: '',
        inputAmount: '',
        status: 'failed',
        elapsedMs: 0,
      };
    }
    results.push(result);

    // Wait for funds to arrive on the destination chain before next hop
    if (i < effectiveHops.length - 1) {
      const dstChain = CHAIN_DEFS[hop.dstChainKey];
      const dstRpcUrl = getRpcUrl(dstChain);
      const walletAddress = (await new ViemWalletProvider(
        privateKey,
        dstChain.viemChain,
        dstRpcUrl,
      ).getWalletAddress()) as Address;

      // Record balance before waiting
      const balanceBefore = await getNativeBalance(dstRpcUrl, dstChain.viemChain, walletAddress);
      console.log(
        `\n  ${dstChain.name} balance before: ${formatNativeBalance(balanceBefore, dstChain.nativeSymbol)}`,
      );
      console.log(`  Waiting for ${dstChain.nativeSymbol} to arrive on ${dstChain.name}...`);

      const pollInterval = 10_000;
      const pollTimeout = Number(process.env.POLL_TIMEOUT_MS || '120000');
      const deadline = Date.now() + pollTimeout;

      let balanceInPlace = false;
      while (Date.now() < deadline) {
        await sleep(pollInterval);
        const balance = await getNativeBalance(dstRpcUrl, dstChain.viemChain, walletAddress);
        if (balance > balanceBefore) {
          if (balanceInPlace) process.stdout.write('\n');
          const received = balance - balanceBefore;
          console.log(
            `  Received ${formatNativeBalance(received, dstChain.nativeSymbol)}, proceeding to next hop.`,
          );
          break;
        }
        overwriteLine(
          `  ${dstChain.name} balance: ${formatNativeBalance(balance, dstChain.nativeSymbol)} (waiting...)`,
        );
        balanceInPlace = true;
      }
    }
  }

  // Print and save summary
  const summary = buildSummaryText(results);
  console.log(`\n${summary}`);
  const file = saveSummary(summary);
  console.log(`\nSummary saved to ${file}`);
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
  console.log(`  --all                    Run all ${FORWARD_HOPS.length} forward hops sequentially\n`);
  console.log(`Forward hops:`);
  for (const hop of FORWARD_HOPS) {
    console.log(`  --${hop.id.padEnd(25)} ${hop.label}`);
  }
  console.log(`\nReturn hops (back to USDT on Sonic):`);
  for (const hop of RETURN_HOPS) {
    console.log(`  --${hop.id.padEnd(25)} ${hop.label}`);
  }
  console.log(`\nEnv vars (all optional):`);
  console.log(`  PRIVATE_KEY              Wallet private key (required)`);
  console.log(`  INPUT_AMOUNT_HUMAN       Input amount (default: use full balance for native)`);
  console.log(`  POLL_TIMEOUT_MS          SDK swap timeout (default: 120000)`);
  console.log(`  <CHAIN>_RPC_URL          RPC override per chain (e.g., BASE_RPC_URL)`);
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const flag = process.argv[2];
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
    await executeAllHops(sodax, privateKey);
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
    let result: HopResult;
    try {
      result = await executeHop(sodax, target, privateKey, 1);
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
    const summary = buildSummaryText([result]);
    console.log(`\n${summary}`);
    const file = saveSummary(summary);
    console.log(`\nSummary saved to ${file}`);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
