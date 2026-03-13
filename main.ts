import dotenv from 'dotenv';
import { type Address, type Hex, getAddress } from 'viem';
import { sonic } from 'viem/chains';
import { IntentsAbi } from './intents.abi';
import {
  type TestCaseName,
  TEST_CASES,
  addressToBytes,
  approveIfNeeded,
  buildSubmitPayload,
  createClients,
  extractIntentFromReceipt,
  getAddressEnv,
  getBigIntEnv,
  getBooleanEnv,
  getHexEnv,
  getInputAmount,
  getMinOutputAmount,
  getRequiredEnv,
  normalizePrivateKey,
  formatElapsed,
  pollIntentStatus,
  submitIntent,
  unixNow,
} from './helpers';

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

async function main() {
  const testCaseName = getTestCaseFromArgs();
  const testCase = TEST_CASES[testCaseName];

  const privateKey = normalizePrivateKey(getRequiredEnv('PRIVATE_KEY'));
  const contractAddress = getAddress(getRequiredEnv('INTENT_CONTRACT_ADDRESS'));
  const rpcUrl = process.env.SONIC_RPC_URL || 'https://rpc.soniclabs.com';
  const backendBaseUrl =
    process.env.BACKEND_SWAP_ENDPOINT || 'https://canary-api.sodax.com/v1/bes/swaps';

  const { account, walletClient, publicClient } = createClients(rpcUrl, privateKey);

  const inputAmount = getInputAmount(testCase);
  const minOutputAmount = getMinOutputAmount(inputAmount);
  const deadline = getBigIntEnv('DEADLINE_UNIX', unixNow() + 3600n);
  const allowPartialFill = getBooleanEnv('ALLOW_PARTIAL_FILL', false);
  const srcChain = getBigIntEnv('SRC_CHAIN', 146n);
  const dstChain = getBigIntEnv('DST_CHAIN', 146n);
  const solver = getAddressEnv(
    'SOLVER_ADDRESS',
    getAddress('0x0000000000000000000000000000000000000000'),
  );
  const data = getHexEnv('INTENT_DATA', '0x');
  const gas = getBigIntEnv('GAS_LIMIT', 2_000_000n);
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? '3000');
  const pollTimeoutMs = Number(process.env.POLL_TIMEOUT_MS ?? '120000');

  const startMs = Date.now();

  console.log(`\nSODAX Swap Intent — ${testCase.name}`);
  console.log(`Wallet  : ${account.address}`);
  console.log(`Backend : ${backendBaseUrl}`);
  console.log(`RPC     : ${rpcUrl}`);

  // Step 1: Check balance & approve
  console.log(`\n[1/5] Check balance & approve`);
  await approveIfNeeded({
    publicClient,
    walletClient,
    account,
    token: testCase.inputToken,
    spender: contractAddress,
    amount: inputAmount,
    decimals: testCase.decimals,
  });

  // Step 2: Create intent on-chain
  console.log(`\n[2/5] Create intent on-chain`);
  console.log(`  Contract : ${contractAddress}`);
  console.log(`  Input    : ${inputAmount.toString()} of ${testCase.inputToken}`);
  console.log(`  Output   : min ${minOutputAmount.toString()} of ${testCase.outputToken}`);
  console.log(
    `  Deadline : ${deadline.toString()} (${new Date(Number(deadline) * 1000).toISOString()})`,
  );
  console.log(`  Chains   : ${srcChain} -> ${dstChain}`);

  const intent = {
    intentId: 0n,
    creator: account.address,
    inputToken: testCase.inputToken,
    outputToken: testCase.outputToken,
    inputAmount,
    minOutputAmount,
    deadline,
    allowPartialFill,
    srcChain,
    dstChain,
    srcAddress: addressToBytes(account.address),
    dstAddress: addressToBytes(account.address),
    solver,
    data,
  } as const;

  const hash = await walletClient.writeContract({
    chain: sonic,
    account,
    address: contractAddress,
    abi: IntentsAbi,
    functionName: 'createIntent',
    args: [intent],
    gas,
  });

  console.log(`  Tx sent: ${hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  Confirmed in block ${receipt.blockNumber} | gas used: ${receipt.gasUsed}`);

  // Step 3: Extract intent from receipt
  console.log(`\n[3/5] Extract intent from receipt`);
  const decodedIntent = extractIntentFromReceipt(receipt);

  // Step 4: Submit to backend
  console.log(`\n[4/5] Submit to backend`);
  const payload = buildSubmitPayload(hash, account.address, decodedIntent);
  await submitIntent(payload, backendBaseUrl);

  // Step 5: Poll status
  console.log(`\n[5/5] Poll status`);
  await pollIntentStatus(hash, backendBaseUrl, pollIntervalMs, pollTimeoutMs);

  console.log(`\nElapsed: ${formatElapsed(startMs)}`);
  console.log(`Done`);
}

main().catch((error) => {
  console.error(`\nFailed:`, error);
  process.exit(1);
});
