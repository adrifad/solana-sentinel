import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { base58Encode } from "@sentinel/domain";
import { loadConfig } from "@sentinel/config";
import { parsePumpPortalMessage } from "@sentinel/providers";
import type { HeliusRpcClient } from "@sentinel/providers";
import type { WalletTransaction } from "@sentinel/providers";
import { LEGACY_TOKEN_PROGRAM_ID } from "@sentinel/security";
import { SentinelStore } from "@sentinel/storage";
import {
  serializeWalletTransactionSummary,
  TokenAnalysisScheduler,
} from "../apps/worker/src/analysis.ts";

const fixture = JSON.parse(
  await readFile("tests/fixtures/pumpportal-created.synthetic.json", "utf8"),
) as Record<string, unknown>;

async function waitForDecision(
  store: SentinelStore,
  mint: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (store.listRiskDecisions(mint).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("analysis report was not persisted before timeout");
}

function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let integer = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    assert.ok(digit >= 0);
    integer = integer * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (integer > 0n) {
    bytes.unshift(Number(integer & 255n));
    integer >>= 8n;
  }
  const leadingZeroes = value.match(/^1+/)?.[0].length ?? 0;
  return Uint8Array.from([
    ...new Array<number>(leadingZeroes).fill(0),
    ...bytes,
  ]);
}

function createEventLogs(input: {
  mint: string;
  creator: string;
  user: string;
}): string[] {
  const string = (value: string): Buffer => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const event = Buffer.concat([
    Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
    string("Verified Launch"),
    string("VER"),
    string("https://example.test/metadata.json"),
    Buffer.from(base58Decode(input.mint)),
    Buffer.alloc(32, 4),
    Buffer.from(base58Decode(input.user)),
    Buffer.from(base58Decode(input.creator)),
    (() => {
      const timestamp = Buffer.alloc(8);
      timestamp.writeBigInt64LE(1_800_000_000n);
      return timestamp;
    })(),
  ]);
  const program = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  return [
    `Program ${program} invoke [1]`,
    `Program data: ${event.toString("base64")}`,
    `Program ${program} success`,
  ];
}

test("historical transaction summaries serialize Pump event bigint timestamps safely", () => {
  const mint = base58Encode(Buffer.alloc(32, 1));
  const user = base58Encode(Buffer.alloc(32, 2));
  const creator = base58Encode(Buffer.alloc(32, 3));
  const summary = serializeWalletTransactionSummary({
    signature: "1".repeat(64),
    slot: 100,
    blockTime: 1_800_000_000,
    succeeded: true,
    feeLamports: 5000,
    accountKeys: [],
    instructions: [],
    logMessages: createEventLogs({ mint, user, creator }),
    preBalances: [],
    postBalances: [],
  });
  const parsed = JSON.parse(summary) as {
    createEvents: Array<{ timestampSeconds: string }>;
  };
  assert.equal(parsed.createEvents[0]?.timestampSeconds, "1800000000");
});

test("detected launch gets persistent fail-closed reports without Helius credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-analysis-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const config = await loadConfig({});
  const scheduler = new TokenAnalysisScheduler({
    store,
    helius: undefined,
    config: config.config,
    configVersion: config.configVersion,
    concurrency: 1,
  });
  try {
    const event = parsePumpPortalMessage(fixture, Date.now());
    store.ingestEvent(event, 10, false);
    store.saveLaunchTradeObservation({
      id: "test-launch-trade-1",
      mint: event.mint,
      signature: "test-launch-trade-signature",
      slot: 100,
      blockTimeUtc: event.firstSeenAtUtc,
      receivedAtUtc: event.firstSeenAtUtc,
      side: "BUY",
      traderWallet: event.launchInitiator ?? null,
      tokenAmountRaw: "100",
      quoteAmountRaw: "5000",
      venue: "PUMP_BONDING_CURVE",
      source: "sanitized-test-observation",
      payloadRef: `sha256:${createHash("sha256").update("trade").digest("hex")}`,
    });
    scheduler.start();
    await waitForDecision(store, event.mint);
    const report = store.getLatestTokenRiskReport(event.mint);
    const decision = store.listRiskDecisions(event.mint)[0];
    assert.equal(report?.status, "MISSING");
    assert.equal(
      report?.reasonCodes.includes("HELIUS_CREDENTIAL_MISSING"),
      true,
    );
    assert.equal(decision?.status, "QUARANTINE");
    assert.equal(
      decision?.evidenceRefs.some((ref) => ref.startsWith("market_event:")),
      true,
    );
    const behavior = store.listLaunchBehaviorSnapshots(event.mint)[0];
    assert.ok(behavior);
    assert.equal(behavior.complete, false);
    assert.equal(behavior.gapReason, "TRADE_STREAM_COMPLETENESS_UNVERIFIED");
    assert.equal(behavior.buyCount, 1);
    assert.equal(
      decision?.evidenceRefs.includes(`launch_behavior:${behavior.id}`),
      true,
    );
    assert.equal(decision?.status, "QUARANTINE");
  } finally {
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration-first discovery persists an incomplete security report and quarantines without creator evidence", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sentinel-migration-analysis-"),
  );
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const config = await loadConfig({});
  const scheduler = new TokenAnalysisScheduler({
    store,
    helius: undefined,
    config: config.config,
    configVersion: config.configVersion,
    concurrency: 1,
  });
  try {
    const event = parsePumpPortalMessage({
      txType: "migrate",
      mint: "So11111111111111111111111111111111111111112",
    });
    store.ingestEvent(event, 10, false);
    const claimed = store.claimMigrationRecoveryJob();
    assert.equal(claimed?.eventId, event.id);
    store.finishMigrationRecoveryJob(
      event.id,
      "FAILED",
      "MIGRATION_SIGNATURE_MISSING",
    );
    scheduler.start();
    await waitForDecision(store, event.mint);
    const report = store.getLatestTokenRiskReport(event.mint);
    const decision = store.listRiskDecisions(event.mint)[0];
    assert.ok(report);
    assert.equal(report.status === "UNSAFE", false);
    assert.equal(decision?.status, "QUARANTINE");
    assert.equal(
      decision?.reasonCodes.includes("MIGRATION_CREATION_EVIDENCE_UNAVAILABLE"),
      true,
    );
    assert.equal(store.getToken(event.mint)?.creator, null);
    assert.equal(
      store.getAnalysisOutcome(event.mint)[0]?.["status"],
      "COMPLETE",
    );
  } finally {
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("over-budget launches are reported without spending Helius requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-analysis-cap-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const config = await loadConfig({});
  let calls = 0;
  const helius = {
    getTransaction: async () => {
      calls += 1;
      throw new Error("unexpected request");
    },
    getAccountInfo: async () => {
      calls += 1;
      throw new Error("unexpected request");
    },
  } as unknown as HeliusRpcClient;
  const scheduler = new TokenAnalysisScheduler({
    store,
    helius,
    config: config.config,
    configVersion: config.configVersion,
    concurrency: 1,
  });
  try {
    const event = parsePumpPortalMessage(fixture, Date.now());
    store.ingestEvent(event, 0, true);
    scheduler.start();
    await waitForDecision(store, event.mint);
    assert.equal(calls, 0);
    assert.equal(
      store
        .getLatestTokenRiskReport(event.mint)
        ?.reasonCodes.includes("TOKEN_OUTSIDE_MONITORING_BUDGET"),
      true,
    );
    const decision = store.listRiskDecisions(event.mint)[0];
    assert.equal(decision?.status, "QUARANTINE");
  } finally {
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified launch evidence keeps claimed creator, Pump creator, user, and fee payer distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-attribution-"));
  const store = new SentinelStore(join(directory, "sentinel.db"));
  await store.open();
  const config = await loadConfig({});
  const event = parsePumpPortalMessage(fixture, Date.now());
  const onChainCreator = base58Encode(Buffer.alloc(32, 3));
  const launchUser = base58Encode(Buffer.alloc(32, 2));
  const transaction: WalletTransaction = {
    signature: event.txSignature ?? "",
    slot: event.slot ?? 0,
    blockTime: 1_700_000_000,
    succeeded: true,
    feeLamports: 5000,
    accountKeys: [
      { pubkey: launchUser, signer: true, writable: true },
      { pubkey: onChainCreator, signer: false, writable: true },
    ],
    instructions: [],
    logMessages: createEventLogs({
      mint: event.mint,
      creator: onChainCreator,
      user: launchUser,
    }),
    preBalances: [],
    postBalances: [],
  };
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(1000n, 36);
  mintData[44] = 9;
  mintData[45] = 1;
  const helius = {
    getTransaction: async () => transaction,
    getSignaturesForAddress: async () => [],
    getAccountInfo: async () => ({
      slot: transaction.slot,
      account: {
        slot: transaction.slot,
        owner: LEGACY_TOKEN_PROGRAM_ID,
        dataBase64: mintData.toString("base64"),
        encoding: "base64",
        executable: false,
      },
    }),
    getTokenSupply: async () => ({
      slot: transaction.slot,
      amountRaw: "1000",
      decimals: 9,
    }),
    getTokenLargestAccounts: async () => ({
      slot: transaction.slot,
      accounts: [],
    }),
  } as unknown as HeliusRpcClient;
  const scheduler = new TokenAnalysisScheduler({
    store,
    helius,
    config: config.config,
    configVersion: config.configVersion,
    concurrency: 1,
  });
  try {
    store.ingestEvent(event, 10, true);
    scheduler.start();
    await waitForDecision(store, event.mint);
    const roles = store.listWalletRoleEvidence(event.mint);
    assert.equal(
      roles.some(
        (item) =>
          item.wallet === onChainCreator &&
          item.role === "CLAIMED_CREATOR" &&
          item.confidenceBps === 10000,
      ),
      true,
    );
    assert.equal(
      roles.some(
        (item) =>
          item.wallet === event.creator &&
          item.source === "PUMPPORTAL_CLAIM" &&
          item.confidenceBps === 5000,
      ),
      true,
    );
    assert.equal(
      roles.some(
        (item) =>
          item.wallet === launchUser && item.role === "LAUNCH_INITIATOR",
      ),
      true,
    );
    assert.equal(
      roles.some(
        (item) => item.wallet === launchUser && item.role === "FEE_PAYER",
      ),
      true,
    );
    assert.equal(
      store.listCreatorLaunches(onChainCreator, transaction.slot).length,
      1,
    );
    assert.equal(
      store
        .getLatestTokenRiskReport(event.mint)
        ?.reasonCodes.includes("HOLDER_DISTRIBUTION_EMPTY"),
      true,
    );
    assert.equal(store.listRiskDecisions(event.mint)[0]?.status, "QUARANTINE");
    const decision = store.listRiskDecisions(event.mint)[0];
    assert.equal(
      decision?.reasonCodes.includes("PROVIDER_CREATOR_CLAIM_MISMATCH"),
      true,
    );
    assert.equal(
      decision?.reasonCodes.includes("PROVIDER_INITIATOR_CLAIM_MISMATCH"),
      true,
    );
  } finally {
    await scheduler.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
