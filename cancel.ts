import dotenv from 'dotenv';
import { Sodax } from '@sodax/sdk';
import { getIntentRelayChainId } from '@sodax/types';
import { privateKeyToAccount } from 'viem/accounts';
import {
  crossCheckIntentJournal,
  findIntentById,
  formatElapsed,
  getRequiredEnv,
  journalIntentToSdkIntent,
  normalizePrivateKey,
} from './helpers';
import { CHAIN_DEFS, ViemWalletProvider, getRpcUrl } from './sdk-helpers';

dotenv.config();

// ----------------------------------------------------------------------------
// CANCEL — cancel a pending (open) intent by its on-chain intentId.
// ----------------------------------------------------------------------------
//
// Usage: tsx cancel.ts <intentId>
//
// Flow:
//   1. Resolve <intentId> → the full Intent struct via the apps/api intent journal
//      (`/intent/user/:wallet`). The contract's cancelIntent needs the whole struct, not
//      just the id, so we rehydrate it from the journal entry (which round-trips to the
//      same intentHash because it is decoded from the on-chain IntentCreated event).
//   2. Derive `srcChainKey` from the intent's relay chain id and broadcast the cancel via
//      `sodax.swaps.cancelIntent` on the source chain.
//   3. Cross-check the journal for the on-chain INTENT_CANCELLED.
//
// Only the creator can cancel, so this must run with the same PRIVATE_KEY that created it.

async function main() {
  const intentId = process.argv[2];
  if (!intentId || !/^\d+$/.test(intentId)) {
    console.error('Usage: tsx cancel.ts <intentId>');
    console.error(
      '  <intentId> — numeric on-chain id of a pending (open) intent created by this wallet',
    );
    process.exit(1);
  }

  const privateKey = normalizePrivateKey(getRequiredEnv('PRIVATE_KEY'));
  const walletAddress = privateKeyToAccount(privateKey).address;
  const apiBaseUrl =
    process.env.INTENT_API_ENDPOINT || 'https://apiv1-1.coolify.iconblockchain.xyz';
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? '3000');
  const crossCheckTimeoutMs = Number(process.env.JOURNAL_CROSSCHECK_TIMEOUT_MS ?? '90000');

  const startMs = Date.now();
  console.log(`\nSODAX Cancel Intent (v2)`);
  console.log(`Wallet  : ${walletAddress}`);
  console.log(`Intent  : ${intentId}`);
  console.log(`Journal : ${apiBaseUrl}`);

  // Step 1: resolve the intent from the journal
  console.log(`\n[1/3] Resolve intent from journal`);
  const entry = await findIntentById(apiBaseUrl, walletAddress, intentId);
  if (!entry) {
    throw new Error(
      `No intent with id ${intentId} found for ${walletAddress} (scanned the latest 100). ` +
        `Only intents created by this wallet can be cancelled.`,
    );
  }
  if (!entry.open) {
    console.log(`  Intent ${intentId} is already closed (open=false) — nothing to cancel.`);
    const terminal = (entry.events ?? []).find(
      (e) => e.eventType === 'intent-filled' || e.eventType === 'intent-cancelled',
    );
    if (terminal) console.log(`  Terminal event: ${terminal.eventType} (${terminal.txHash})`);
    return;
  }
  console.log(`  Found open intent ${intentId} (intentHash ${entry.intentHash})`);

  // Step 2: derive srcChainKey + broadcast the cancel
  const intent = journalIntentToSdkIntent(entry.intent);
  const srcDef = Object.values(CHAIN_DEFS).find(
    (d) => getIntentRelayChainId(d.chainKey) === intent.srcChain,
  );
  if (!srcDef) {
    throw new Error(
      `Unsupported source chain (relay id ${intent.srcChain.toString()}) — not in CHAIN_DEFS`,
    );
  }

  console.log(`\n[2/3] Cancel on ${srcDef.name} (${srcDef.chainKey})`);
  const rpcUrl = getRpcUrl(srcDef);
  const walletProvider = new ViemWalletProvider(privateKey, srcDef.viemChain, rpcUrl);

  const sodax = new Sodax();
  const result = await sodax.swaps.cancelIntent({
    params: { srcChainKey: srcDef.chainKey, intent },
    // biome-ignore lint/suspicious/noExplicitAny: walletProvider is EVM; param type is the full chain-key union
    walletProvider: walletProvider as any,
  });
  if (!result.ok) {
    throw new Error(
      `cancelIntent failed: ${JSON.stringify(result.error, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  }
  console.log(`  Cancel submitted`);
  console.log(`  srcChainTxHash: ${result.value.srcChainTxHash}`);
  console.log(`  dstChainTxHash: ${result.value.dstChainTxHash}`);

  // Step 3: confirm the on-chain cancellation in the journal
  console.log(`\n[3/3] Cross-check intent journal`);
  await crossCheckIntentJournal(
    apiBaseUrl,
    { intentHash: entry.intentHash },
    pollIntervalMs,
    crossCheckTimeoutMs,
  );

  console.log(`\nElapsed: ${formatElapsed(startMs)}`);
  console.log(`Done`);
}

main().catch((error) => {
  console.error(`\nFailed:`, error);
  process.exit(1);
});
