import {
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  createPublicClient,
  createWalletClient,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  sonic,
  base,
  optimism,
  arbitrum,
  avalanche,
  bsc,
  polygon,
  mainnet,
  hyperEvm,
  lightlinkPhoenix,
  redbellyMainnet,
  kaia,
} from 'viem/chains';
import {
  type IEvmWalletProvider,
  type EvmRawTransaction,
  type EvmRawTransactionReceipt,
  type SpokeChainKey,
} from '@sodax/sdk';

// ----------------------------------------------------------------------------
// VIEM WALLET PROVIDER (implements IEvmWalletProvider)
// ----------------------------------------------------------------------------

export class ViemWalletProvider implements IEvmWalletProvider {
  // v2 SDK uses `chainType` as the discriminant to refine wallet providers.
  readonly chainType = 'EVM' as const;
  private walletClient;
  private publicClient;

  constructor(privateKey: Hex, chain: Chain, rpcUrl: string) {
    const account = privateKeyToAccount(privateKey);
    // Strip the chain's custom `fees` config so viem uses pure RPC-based fee
    // estimation. Some chains (e.g. Polygon) ship with a `fees` override that
    // produces a maxFeePerGas far below the actual base fee, causing every
    // transaction to fail with FeeCapTooLowError.
    const cleanChain = { ...chain, fees: undefined } as Chain;
    this.walletClient = createWalletClient({
      account,
      chain: cleanChain,
      transport: http(rpcUrl),
    });
    this.publicClient = createPublicClient({
      chain: cleanChain,
      transport: http(rpcUrl),
    });
  }

  async getWalletAddress(): Promise<Address> {
    const [address] = await this.walletClient.getAddresses();
    return address;
  }

  async sendTransaction(tx: EvmRawTransaction): Promise<Hash> {
    const params = {
      to: tx.to as Address,
      data: tx.data as Hex,
      value: tx.value ? BigInt(tx.value) : undefined,
    };
    try {
      return await this.walletClient.sendTransaction(params);
    } catch (err: any) {
      // Some RPCs have broken EIP-1559 support during gas estimation
      // (gasPrice conflict, FeeCapTooLow with bogus maxFeePerGas, etc.).
      // Retry as a legacy tx with manually-fetched gasPrice and gas limit
      // so viem doesn't need to call eth_estimateGas with fee fields.
      const msg = String(err?.details ?? err?.cause?.details ?? '');
      const isGasConflict = msg.includes('gasPrice') && msg.includes('maxFeePerGas');
      const isFeeCapLow =
        msg.includes('max fee per gas less than block base fee') ||
        err?.cause?.name === 'FeeCapTooLowError';
      if (isGasConflict || isFeeCapLow) {
        const from = await this.getWalletAddress();
        const [gasPrice, gas] = await Promise.all([
          this.publicClient.getGasPrice(),
          this.publicClient.estimateGas({
            account: from,
            to: params.to,
            data: params.data,
            value: params.value,
          }),
        ]);
        return this.walletClient.sendTransaction({
          ...params,
          type: 'legacy',
          gasPrice,
          gas,
        });
      }
      throw err;
    }
  }

  async waitForTransactionReceipt(hash: Hash): Promise<EvmRawTransactionReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return receipt as unknown as EvmRawTransactionReceipt;
  }
}

// ----------------------------------------------------------------------------
// CHAIN REGISTRY
// ----------------------------------------------------------------------------

export type ChainDef = {
  chainKey: SpokeChainKey;
  viemChain: Chain;
  name: string;
  nativeSymbol: string;
  defaultRpcUrl: string;
  rpcEnvVar: string;
};

export const CHAIN_DEFS: Record<string, ChainDef> = {
  sonic: {
    chainKey: 'sonic',
    viemChain: sonic,
    name: 'Sonic',
    nativeSymbol: 'S',
    defaultRpcUrl: 'https://rpc.soniclabs.com',
    rpcEnvVar: 'SONIC_RPC_URL',
  },
  base: {
    chainKey: '0x2105.base',
    viemChain: base,
    name: 'Base',
    nativeSymbol: 'ETH',
    defaultRpcUrl: 'https://mainnet.base.org',
    rpcEnvVar: 'BASE_RPC_URL',
  },
  optimism: {
    chainKey: '0xa.optimism',
    viemChain: optimism,
    name: 'Optimism',
    nativeSymbol: 'ETH',
    defaultRpcUrl: 'https://mainnet.optimism.io',
    rpcEnvVar: 'OPTIMISM_RPC_URL',
  },
  arbitrum: {
    chainKey: '0xa4b1.arbitrum',
    viemChain: arbitrum,
    name: 'Arbitrum',
    nativeSymbol: 'ETH',
    defaultRpcUrl: 'https://arb1.arbitrum.io/rpc',
    rpcEnvVar: 'ARBITRUM_RPC_URL',
  },
  avalanche: {
    chainKey: '0xa86a.avax',
    viemChain: avalanche,
    name: 'Avalanche',
    nativeSymbol: 'AVAX',
    defaultRpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    rpcEnvVar: 'AVALANCHE_RPC_URL',
  },
  bsc: {
    chainKey: '0x38.bsc',
    viemChain: bsc,
    name: 'BSC',
    nativeSymbol: 'BNB',
    defaultRpcUrl: 'https://bsc-dataseed.binance.org',
    rpcEnvVar: 'BSC_RPC_URL',
  },
  polygon: {
    chainKey: '0x89.polygon',
    viemChain: polygon,
    name: 'Polygon',
    nativeSymbol: 'POL',
    defaultRpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    rpcEnvVar: 'POLYGON_RPC_URL',
  },
  ethereum: {
    chainKey: 'ethereum',
    viemChain: mainnet,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    defaultRpcUrl: 'https://eth.llamarpc.com',
    rpcEnvVar: 'ETHEREUM_RPC_URL',
  },
  hyper: {
    chainKey: 'hyper',
    viemChain: hyperEvm,
    name: 'Hyperliquid',
    nativeSymbol: 'HYPE',
    defaultRpcUrl: 'https://rpc.hyperliquid.xyz/evm',
    rpcEnvVar: 'HYPER_RPC_URL',
  },
  lightlink: {
    chainKey: 'lightlink',
    viemChain: lightlinkPhoenix,
    name: 'LightLink',
    nativeSymbol: 'ETH',
    defaultRpcUrl: 'https://replicator.phoenix.lightlink.io/rpc/v1',
    rpcEnvVar: 'LIGHTLINK_RPC_URL',
  },
  redbelly: {
    chainKey: 'redbelly',
    viemChain: redbellyMainnet,
    name: 'Redbelly',
    nativeSymbol: 'RBNT',
    defaultRpcUrl: 'https://governors.mainnet.redbelly.network',
    rpcEnvVar: 'REDBELLY_RPC_URL',
  },
  kaia: {
    chainKey: '0x2019.kaia',
    viemChain: kaia,
    name: 'Kaia',
    nativeSymbol: 'KAIA',
    defaultRpcUrl: 'https://public-en.node.kaia.io',
    rpcEnvVar: 'KAIA_RPC_URL',
  },
} as const;

// ----------------------------------------------------------------------------
// SOLANA (NON-EVM) SPOKE
// ----------------------------------------------------------------------------
//
// `CHAIN_DEFS` above is typed to viem's `Chain`, so Solana cannot go in it. It gets its own
// def, sharing the field names that matter (`chainKey`, RPC resolution) so `getRpcUrl` and
// the leverage script's chain registry can treat EVM and Solana sources uniformly.
//
// Only the leverage script uses this — `chain-hop.ts` and the swap flow remain EVM-only.

export type SolanaChainDef = {
  chainKey: SpokeChainKey;
  name: string;
  nativeSymbol: string;
  nativeDecimals: number;
  defaultRpcUrl: string;
  rpcEnvVar: string;
};

export const SOLANA_DEF: SolanaChainDef = {
  chainKey: 'solana',
  name: 'Solana',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  // Last-resort public endpoint. It is aggressively rate-limited — point SOLANA_RPC_URL at a
  // dedicated provider for anything that broadcasts.
  defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
  rpcEnvVar: 'SOLANA_RPC_URL',
};

/**
 * Native SOL as the SODAX spoke config addresses it: the system program id. Note this is a
 * different convention from EVM spokes, which use the zero address (`NATIVE` below).
 */
export const SOLANA_NATIVE = '11111111111111111111111111111111';

// ----------------------------------------------------------------------------
// HOP DEFINITIONS
// ----------------------------------------------------------------------------

export const NATIVE = '0x0000000000000000000000000000000000000000';
export const SONIC_USDT = '0x6047828dc181963ba44974801ff68e538da5eaf9';

// Non-sonic chain keys (used for balances/sweep)
export const REMOTE_CHAIN_KEYS = Object.keys(CHAIN_DEFS).filter((k) => k !== 'sonic');

export type HopDef = {
  id: string;
  label: string;
  srcChainKey: string;
  dstChainKey: string;
  inputToken: string;
  outputToken: string;
};

export const FORWARD_HOPS: HopDef[] = [
  {
    id: 'sonic-to-base',
    label: 'USDT(Sonic) → ETH(Base)',
    srcChainKey: 'sonic',
    dstChainKey: 'base',
    inputToken: SONIC_USDT,
    outputToken: NATIVE,
  },
  {
    id: 'base-to-optimism',
    label: 'ETH(Base) → ETH(Optimism)',
    srcChainKey: 'base',
    dstChainKey: 'optimism',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'optimism-to-arbitrum',
    label: 'ETH(Optimism) → ETH(Arbitrum)',
    srcChainKey: 'optimism',
    dstChainKey: 'arbitrum',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'arbitrum-to-avalanche',
    label: 'ETH(Arbitrum) → AVAX(Avalanche)',
    srcChainKey: 'arbitrum',
    dstChainKey: 'avalanche',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'avalanche-to-bsc',
    label: 'AVAX(Avalanche) → BNB(BSC)',
    srcChainKey: 'avalanche',
    dstChainKey: 'bsc',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'bsc-to-polygon',
    label: 'BNB(BSC) → POL(Polygon)',
    srcChainKey: 'bsc',
    dstChainKey: 'polygon',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'polygon-to-ethereum',
    label: 'POL(Polygon) → ETH(Ethereum)',
    srcChainKey: 'polygon',
    dstChainKey: 'ethereum',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'ethereum-to-hyper',
    label: 'ETH(Ethereum) → HYPE(Hyperliquid)',
    srcChainKey: 'ethereum',
    dstChainKey: 'hyper',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'hyper-to-lightlink',
    label: 'HYPE(Hyperliquid) → ETH(LightLink)',
    srcChainKey: 'hyper',
    dstChainKey: 'lightlink',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'lightlink-to-redbelly',
    label: 'ETH(LightLink) → RBNT(Redbelly)',
    srcChainKey: 'lightlink',
    dstChainKey: 'redbelly',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
  {
    id: 'redbelly-to-kaia',
    label: 'RBNT(Redbelly) → KAIA(Kaia)',
    srcChainKey: 'redbelly',
    dstChainKey: 'kaia',
    inputToken: NATIVE,
    outputToken: NATIVE,
  },
];

export const RETURN_HOPS: HopDef[] = [
  {
    id: 'base-to-sonic',
    label: 'ETH(Base) → USDT(Sonic)',
    srcChainKey: 'base',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'optimism-to-sonic',
    label: 'ETH(Optimism) → USDT(Sonic)',
    srcChainKey: 'optimism',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'arbitrum-to-sonic',
    label: 'ETH(Arbitrum) → USDT(Sonic)',
    srcChainKey: 'arbitrum',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'avalanche-to-sonic',
    label: 'AVAX(Avalanche) → USDT(Sonic)',
    srcChainKey: 'avalanche',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'bsc-to-sonic',
    label: 'BNB(BSC) → USDT(Sonic)',
    srcChainKey: 'bsc',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'polygon-to-sonic',
    label: 'POL(Polygon) → USDT(Sonic)',
    srcChainKey: 'polygon',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'ethereum-to-sonic',
    label: 'ETH(Ethereum) → USDT(Sonic)',
    srcChainKey: 'ethereum',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'hyper-to-sonic',
    label: 'HYPE(Hyperliquid) → USDT(Sonic)',
    srcChainKey: 'hyper',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'lightlink-to-sonic',
    label: 'ETH(LightLink) → USDT(Sonic)',
    srcChainKey: 'lightlink',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'redbelly-to-sonic',
    label: 'RBNT(Redbelly) → USDT(Sonic)',
    srcChainKey: 'redbelly',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
  {
    id: 'kaia-to-sonic',
    label: 'KAIA(Kaia) → USDT(Sonic)',
    srcChainKey: 'kaia',
    dstChainKey: 'sonic',
    inputToken: NATIVE,
    outputToken: SONIC_USDT,
  },
];

// ----------------------------------------------------------------------------
// RPC URL RESOLVER
// ----------------------------------------------------------------------------
//
// v2 note: the SDK no longer needs a hand-built `SpokeProvider`. `swaps.createIntent`
// (broadcast mode) takes the `IEvmWalletProvider` directly and resolves the spoke
// provider internally from `params.srcChainKey`, so the old `createSpokeProvider`
// factory (and the `SonicSpokeProvider`/`spokeChainConfig` plumbing) is gone.

/** Anything carrying an RPC override env var plus a default — `ChainDef` or `SolanaChainDef`. */
export type RpcConfigurable = { defaultRpcUrl: string; rpcEnvVar: string };

export function getRpcUrl(chainDef: RpcConfigurable): string {
  return process.env[chainDef.rpcEnvVar] || chainDef.defaultRpcUrl;
}

// ----------------------------------------------------------------------------
// BALANCE READER
// ----------------------------------------------------------------------------

export async function getNativeBalance(
  rpcUrl: string,
  chain: Chain,
  address: Address,
): Promise<bigint> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return client.getBalance({ address });
}

export function formatNativeBalance(balance: bigint, symbol: string): string {
  return `${formatEther(balance)} ${symbol}`;
}

// ----------------------------------------------------------------------------
// DISABLED CHAINS
// ----------------------------------------------------------------------------

export function getDisabledChains(): Set<string> {
  const raw = process.env.DISABLED_CHAINS;
  if (!raw || raw.trim() === '') return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`WARNING: DISABLED_CHAINS is not valid JSON, ignoring: ${raw}`);
    return new Set();
  }

  if (!Array.isArray(parsed)) {
    console.warn(`WARNING: DISABLED_CHAINS must be a JSON array, ignoring`);
    return new Set();
  }

  const validKeys = new Set(Object.keys(CHAIN_DEFS));
  const disabled = new Set<string>();

  for (const item of parsed) {
    const key = String(item).toLowerCase();
    if (key === 'sonic') {
      console.warn(`WARNING: Cannot disable sonic (hub chain), ignoring`);
      continue;
    }
    if (!validKeys.has(key)) {
      console.warn(`WARNING: Unknown chain key '${key}' in DISABLED_CHAINS, ignoring`);
      continue;
    }
    disabled.add(key);
  }

  if (disabled.size > 0) {
    console.log(`Disabled chains: ${[...disabled].join(', ')}`);
  }

  return disabled;
}

export function buildEffectiveHops(hops: HopDef[], disabled: Set<string>): HopDef[] {
  if (disabled.size === 0) return hops;

  // Extract the ordered chain sequence from the hops
  const chainSequence: string[] = [hops[0].srcChainKey];
  for (const hop of hops) {
    chainSequence.push(hop.dstChainKey);
  }

  // Remove disabled chains
  const effective = chainSequence.filter((k) => !disabled.has(k));

  if (effective.length < 2) {
    console.warn(`WARNING: All non-sonic chains are disabled, no hops to run`);
    return [];
  }

  // Rebuild hops between adjacent pairs
  const result: HopDef[] = [];
  for (let i = 0; i < effective.length - 1; i++) {
    const src = effective[i];
    const dst = effective[i + 1];
    const srcDef = CHAIN_DEFS[src];
    const dstDef = CHAIN_DEFS[dst];

    const inputToken = src === 'sonic' ? SONIC_USDT : NATIVE;
    const outputToken = NATIVE;

    result.push({
      id: `${src}-to-${dst}`,
      label: `${src === 'sonic' ? 'USDT' : srcDef.nativeSymbol}(${srcDef.name}) → ${dstDef.nativeSymbol}(${dstDef.name})`,
      srcChainKey: src,
      dstChainKey: dst,
      inputToken,
      outputToken,
    });
  }

  return result;
}
