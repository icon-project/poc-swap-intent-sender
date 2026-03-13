import {
  http,
  type Address,
  type Hex,
  type TransactionReceipt,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sonic } from 'viem/chains';
import { IntentsAbi } from './intents.abi';

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

export type DecodedIntent = {
  intentHash: Hex;
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

export type SubmitTxPayload = {
  txHash: Hex;
  srcChainId: string;
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
// INTENT DECODING
// ----------------------------------------------------------------------------

export function extractIntentFromReceipt(receipt: TransactionReceipt): DecodedIntent {
  console.log(`  Scanning ${receipt.logs.length} logs for IntentCreated event...`);

  for (const logEntry of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: IntentsAbi,
        data: logEntry.data,
        topics: logEntry.topics,
      });

      if (decoded.eventName !== 'IntentCreated') continue;

      const i = decoded.args.intent;
      const result: DecodedIntent = {
        intentHash: decoded.args.intentHash as Hex,
        intentId: i.intentId.toString(),
        creator: i.creator,
        inputToken: i.inputToken,
        outputToken: i.outputToken,
        inputAmount: i.inputAmount.toString(),
        minOutputAmount: i.minOutputAmount.toString(),
        deadline: i.deadline.toString(),
        allowPartialFill: i.allowPartialFill,
        srcChain: i.srcChain.toString(),
        dstChain: i.dstChain.toString(),
        srcAddress: i.srcAddress as Hex,
        dstAddress: i.dstAddress as Hex,
        solver: i.solver,
        data: i.data as Hex,
      };

      console.log(`  IntentCreated decoded`);
      console.log(`  Intent hash : ${result.intentHash}`);
      console.log(`  Intent ID   : ${result.intentId}`);
      return result;
    } catch {
      // Not an IntentsAbi event — skip
    }
  }

  throw new Error('IntentCreated event not found in receipt');
}

// ----------------------------------------------------------------------------
// BACKEND INTERACTION
// ----------------------------------------------------------------------------

export function buildSubmitPayload(
  txHash: Hex,
  walletAddress: Address,
  decodedIntent: DecodedIntent,
): SubmitTxPayload {
  return {
    txHash,
    srcChainId: 'sonic',
    walletAddress,
    intent: {
      intentId: decodedIntent.intentId,
      creator: decodedIntent.creator,
      inputToken: decodedIntent.inputToken,
      outputToken: decodedIntent.outputToken,
      inputAmount: decodedIntent.inputAmount,
      minOutputAmount: decodedIntent.minOutputAmount,
      deadline: decodedIntent.deadline,
      allowPartialFill: decodedIntent.allowPartialFill,
      srcChain: decodedIntent.srcChain,
      dstChain: decodedIntent.dstChain,
      srcAddress: decodedIntent.srcAddress,
      dstAddress: decodedIntent.dstAddress,
      solver: decodedIntent.solver,
      data: decodedIntent.data,
    },
    relayData: '0x',
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

export async function pollIntentStatus(
  txHash: string,
  backendBaseUrl: string,
  intervalMs = 3000,
  timeoutMs = 120000,
  srcChainId = 'sonic',
) {
  const url = `${backendBaseUrl}/submit-tx/status?txHash=${txHash}&srcChainId=${srcChainId}`;
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
      }

      console.log(`\n  Full response:`);
      console.dir(body, { depth: null });
      return body;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Polling timed out after ${timeoutMs}ms — last status: ${lastStatus}`);
}
