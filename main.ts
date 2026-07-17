import dotenv from 'dotenv';
import type { Address } from 'viem';
import { Sodax, type CreateIntentParams } from '@sodax/sdk';
import { getSolverConfig } from '@sodax/types';
import {
  type TestCaseName,
  TEST_CASES,
  approveIfNeeded,
  buildSubmitPayload,
  createClients,
  getBigIntEnv,
  getBooleanEnv,
  getInputAmount,
  getMinOutputAmount,
  getRequiredEnv,
  normalizePrivateKey,
  formatElapsed,
  pollIntentStatus,
  crossCheckIntentJournal,
  submitIntent,
  unixNow,
} from './helpers';
import { CHAIN_DEFS, ViemWalletProvider, getRpcUrl } from './sdk-helpers';

dotenv.config();

// ----------------------------------------------------------------------------
// CLI FLAG PARSING
// ----------------------------------------------------------------------------

const FLAG_TO_CASE: Record<string, TestCaseName> = {
  '--sonic-usdt-to-sonic-usdc': 'usdt-to-usdc',
  '--sonic-usdc-to-sonic-usdt': 'usdc-to-usdt',
};

function getTestCaseFromArgs(): TestCaseName {
  const flag = process.argv[2];
  if (!flag) return 'usdt-to-usdc';
  const caseName = FLAG_TO_CASE[flag];
  if (!caseName) {
    console.error(`Unknown flag: ${flag}`);
    console.error(`Usage: tsx main.ts [--sonic-usdt-to-sonic-usdc | --sonic-usdc-to-sonic-usdt]`);
    process.exit(1);
  }
  return caseName;
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
//
// swaps v2 flow (Sonic same-chain USDT <-> USDC):
//   1. approve the intents contract to spend the input ERC20
//   2. build + broadcast the create-intent tx via the SDK (returns { tx, intent, relayData })
//   3. submit { txHash, srcChainKey, intent, relayData } to POST /v1/swaps/submit-tx
//   4. PRIMARY: poll GET /v1/swaps/submit-tx/status until terminal (solved/failed)
//   5. cross-check the intent journal (apps/api) for independent on-chain confirmation
//
// Unlike the v1 PoC, the intent is built by the SDK (correct relay chain ids + relay data)
// rather than hand-rolled, so there is no on-chain ABI decode and no INTENT_CONTRACT_ADDRESS.

async function main() {
  const testCaseName = getTestCaseFromArgs();
  const testCase = TEST_CASES[testCaseName];

  const privateKey = normalizePrivateKey(getRequiredEnv('PRIVATE_KEY'));
  const sonicDef = CHAIN_DEFS['sonic'];
  const rpcUrl = getRpcUrl(sonicDef);
  const backendBaseUrl = process.env.BACKEND_SWAP_ENDPOINT || 'https://api.sodax.com/v1/swaps';

  // Base URL for the soft intent-journal cross-check (apps/api, reached via the public
  // `/v1/be` gateway prefix). The journal is on-chain-derived, so any deployment is equivalent.
  const apiBaseUrl = process.env.INTENT_API_ENDPOINT || 'https://api.sodax.com/v1/be';

  const { account, walletClient, publicClient } = createClients(rpcUrl, privateKey);
  const walletProvider = new ViemWalletProvider(privateKey, sonicDef.viemChain, rpcUrl);

  const inputAmount = getInputAmount(testCase);
  const minOutputAmount = getMinOutputAmount(inputAmount);
  // Deadline: absolute `DEADLINE_UNIX` wins if set, else `now + DEADLINE_OFFSET_SECONDS`
  // (default 1h). The relative offset is recomputed each run so it never goes stale.
  const deadline = process.env.DEADLINE_UNIX
    ? getBigIntEnv('DEADLINE_UNIX', unixNow())
    : unixNow() + getBigIntEnv('DEADLINE_OFFSET_SECONDS', 3600n);
  const allowPartialFill = getBooleanEnv('ALLOW_PARTIAL_FILL', false);
  const intentsContract = getSolverConfig().intentsContract as Address;
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? '3000');
  const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? '120000');

  const startMs = Date.now();

  console.log(`\nSODAX Swap Intent (v2) — ${testCase.name}`);
  console.log(`Wallet  : ${account.address}`);
  console.log(`Backend : ${backendBaseUrl}`);
  console.log(`RPC     : ${rpcUrl}`);

  // Step 1: Check balance & approve the intents contract (Sonic-source intents are not
  // bundled with an approval multicall by the SDK, so we approve up front).
  console.log(`\n[1/5] Check balance & approve`);
  await approveIfNeeded({
    publicClient,
    walletClient,
    account,
    token: testCase.inputToken,
    spender: intentsContract,
    amount: inputAmount,
    decimals: testCase.decimals,
  });

  // Step 2: Build + broadcast the create-intent tx via the SDK
  console.log(`\n[2/5] Create intent on-chain via SDK`);
  const intentParams: CreateIntentParams = {
    inputToken: testCase.inputToken,
    outputToken: testCase.outputToken,
    inputAmount,
    minOutputAmount,
    deadline,
    allowPartialFill,
    srcChainKey: 'sonic',
    dstChainKey: 'sonic',
    srcAddress: account.address.toLowerCase(),
    dstAddress: account.address.toLowerCase(),
    solver: '0x0000000000000000000000000000000000000000',
    data: '0x',
  };

  console.log(`  Intents contract: ${intentsContract}`);
  console.log(`  Input    : ${inputAmount.toString()} of ${testCase.inputToken}`);
  console.log(`  Output   : min ${minOutputAmount.toString()} of ${testCase.outputToken}`);
  console.log(
    `  Deadline : ${deadline.toString()} (${new Date(Number(deadline) * 1000).toISOString()})`,
  );

  const createResult = await sodaxCreateIntent(intentParams, walletProvider);
  const { tx: txHash, intent, relayData } = createResult;
  console.log(`  Tx sent  : ${txHash}`);
  console.log(`  Intent ID: ${intent.intentId.toString()}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  console.log(`  Confirmed in block ${receipt.blockNumber} | gas used: ${receipt.gasUsed}`);

  // Step 3: Submit to backend
  console.log(`\n[3/5] Submit to backend`);
  const payload = buildSubmitPayload(
    txHash as `0x${string}`,
    account.address,
    'sonic',
    intent,
    relayData.payload,
  );
  await submitIntent(payload, backendBaseUrl);

  // Step 4: PRIMARY status — the swaps-api v2 submit-tx/status route.
  console.log(`\n[4/5] Poll swaps-api submit-tx/status`);
  await pollIntentStatus(txHash as string, backendBaseUrl, pollIntervalMs, pollTimeoutMs, 'sonic');

  // Step 5: Independent on-chain confirmation via the intent journal (apps/api). For a Sonic
  // same-chain swap the broadcast tx IS the hub intent tx, so we look it up precisely by txHash.
  console.log(`\n[5/5] Cross-check intent journal`);
  const crossCheckTimeoutMs = Number(process.env.JOURNAL_CROSSCHECK_TIMEOUT_MS ?? '90000');
  await crossCheckIntentJournal(
    apiBaseUrl,
    { txHash: txHash as string },
    pollIntervalMs,
    crossCheckTimeoutMs,
  );

  console.log(`\nElapsed: ${formatElapsed(startMs)}`);
  console.log(`Done`);
}

// Thin wrapper so the createIntent call site stays readable; throws on the SDK Result error.
async function sodaxCreateIntent(params: CreateIntentParams, walletProvider: ViemWalletProvider) {
  const sodax = new Sodax();
  const result = await sodax.swaps.createIntent({
    params,
    // biome-ignore lint/suspicious/noExplicitAny: walletProvider is EVM; param type is the full chain-key union
    walletProvider: walletProvider as any,
  });
  if (!result.ok) {
    throw new Error(
      `Intent creation failed: ${JSON.stringify(result.error, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  }
  return result.value;
}

main().catch((error) => {
  console.error(`\nFailed:`, error);
  process.exit(1);
});
