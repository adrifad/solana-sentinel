import assert from "node:assert/strict";
import test from "node:test";
import { base58Encode } from "@sentinel/domain";
import {
  decodePumpCreateEvents,
  transactionFeePayer,
  transactionSigners,
} from "@sentinel/intelligence";
import {
  LEGACY_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  assessTestTokenMetadata,
  decodeMintAccount,
  ratioBps,
} from "@sentinel/security";
import { evaluateRiskDecision } from "@sentinel/strategy";
import type { CreatorReputation, TokenRiskReport } from "@sentinel/domain";
import type { WalletTransaction } from "@sentinel/providers";

function mintBytes(): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1_000_000_000n, 36);
  data[44] = 9;
  data[45] = 1;
  return data;
}

test("legacy mint decoding preserves raw supply and rejects active authorities", () => {
  const decoded = decodeMintAccount(
    LEGACY_TOKEN_PROGRAM_ID,
    mintBytes().toString("base64"),
  );
  assert.equal(decoded.status, "SUPPORTED");
  assert.equal(decoded.supplyRaw, "1000000000");
  assert.equal(decoded.decimals, 9);

  const unsafe = mintBytes();
  unsafe.writeUInt32LE(1, 0);
  unsafe[4] = 7;
  const activeAuthority = decodeMintAccount(
    LEGACY_TOKEN_PROGRAM_ID,
    unsafe.toString("base64"),
  );
  assert.equal(activeAuthority.status, "UNSAFE");
  assert.equal(
    activeAuthority.reasonCodes.includes("MINT_AUTHORITY_ACTIVE"),
    true,
  );
});

test("Token-2022 unknown and malformed extensions fail closed", () => {
  const unknown = Buffer.alloc(170);
  mintBytes().copy(unknown);
  unknown[165] = 1;
  unknown.writeUInt16LE(29, 166);
  unknown.writeUInt16LE(0, 168);
  const unknownResult = decodeMintAccount(
    TOKEN_2022_PROGRAM_ID,
    unknown.toString("base64"),
  );
  assert.equal(unknownResult.status, "UNSUPPORTED");
  assert.equal(
    unknownResult.reasonCodes.includes("TOKEN_EXTENSION_UNSUPPORTED"),
    true,
  );

  const malformed = Buffer.alloc(167);
  mintBytes().copy(malformed);
  malformed[165] = 1;
  malformed[166] = 2;
  assert.equal(
    decodeMintAccount(TOKEN_2022_PROGRAM_ID, malformed.toString("base64"))
      .status,
    "UNSUPPORTED",
  );
});

test("ratio uses integer arithmetic and rejects invalid inputs", () => {
  assert.equal(ratioBps(1n, 3n), 3333);
  assert.equal(ratioBps(10n ** 30n, 10n ** 30n), 10000);
  assert.equal(ratioBps(2n, 1n), 10000);
  assert.equal(ratioBps(1n, 0n), null);
});

test("test-token metadata heuristic flags explicit labels without calling ordinary names tests", () => {
  assert.deepEqual(
    assessTestTokenMetadata({ name: "Demo Token", symbol: "DEMO", uri: null }),
    {
      classification: "LIKELY_TEST",
      confidenceBps: 7000,
      reasonCodes: ["TEST_TOKEN_METADATA_PATTERN"],
    },
  );
  assert.equal(
    assessTestTokenMetadata({ name: "Contest", symbol: "CTST", uri: null })
      .classification,
    "UNKNOWN",
  );
});

test("Pump CreateEvent separates creator from launch initiator and fee payer", () => {
  const creator = base58Encode(Buffer.alloc(32, 1));
  const user = base58Encode(Buffer.alloc(32, 2));
  const mint = base58Encode(Buffer.alloc(32, 3));
  const discriminator = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
  const string = (value: string) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const event = Buffer.concat([
    discriminator,
    string("Name"),
    string("SYM"),
    string("https://example.test/meta"),
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 4),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 1),
    Buffer.alloc(8),
  ]);
  const programId = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const decoded = decodePumpCreateEvents([
    `Program ${programId} invoke [1]`,
    `Program data: ${event.toString("base64")}`,
    `Program ${programId} success`,
  ]);
  assert.equal(decoded.length, 1);
  assert.deepEqual(
    {
      mint: decoded[0]?.mint,
      creator: decoded[0]?.creator,
      user: decoded[0]?.user,
    },
    { mint, creator, user },
  );

  const tx: WalletTransaction = {
    signature: "signature",
    slot: 10,
    blockTime: 1,
    succeeded: true,
    feeLamports: 5000,
    accountKeys: [
      { pubkey: user, signer: true, writable: true },
      { pubkey: creator, signer: true, writable: true },
    ],
    instructions: [],
    logMessages: [],
    preBalances: [],
    postBalances: [],
  };
  assert.equal(transactionFeePayer(tx), user);
  assert.deepEqual(transactionSigners(tx), [user, creator]);
});

test("risk decision cannot be BUY_ELIGIBLE with unknown security or incomplete history", () => {
  const now = Date.parse("2026-11-01T00:00:00.000Z");
  const security: TokenRiskReport = {
    id: "security-1",
    mint: base58Encode(Buffer.alloc(32, 3)),
    status: "SUPPORTED",
    programId: LEGACY_TOKEN_PROGRAM_ID,
    mintAuthority: null,
    freezeAuthority: null,
    supplyRaw: "1000",
    decimals: 9,
    extensions: [],
    topHolderConcentrationBps: null,
    creatorConcentrationRaw: null,
    clusterConcentrationRaw: null,
    holderSampleCount: 0,
    holderSampleComplete: false,
    testTokenClassification: "UNKNOWN",
    testTokenConfidenceBps: 0,
    reasonCodes: [],
    source: "HELIUS_RPC",
    asOfSlot: 10,
    observedAtUtc: new Date(now).toISOString(),
    confidenceBps: 10000,
    evidenceRefs: ["helius_account:mint:10"],
  };
  const creator: CreatorReputation = {
    wallet: base58Encode(Buffer.alloc(32, 1)),
    status: "KNOWN",
    launchesObserved: 1,
    suspiciousIndicators: [],
    confidenceBps: 5000,
    historyComplete: false,
    asOfSlot: 10,
    computedAtUtc: new Date(now).toISOString(),
    freshUntilUtc: new Date(now + 60000).toISOString(),
    evidenceRefs: [],
  };
  const decision = evaluateRiskDecision({
    mint: security.mint,
    configVersion: "a".repeat(64),
    security: { ...security, status: "MISSING" },
    creator,
    marketPhase: "PUMP_CURVE",
    exitValidation: "PASS",
    startedAtMs: now,
    nowMs: now,
  });
  assert.equal(decision.status, "QUARANTINE");
  assert.equal(
    decision.reasonCodes.includes("CREATOR_HISTORY_INCOMPLETE"),
    true,
  );
  assert.equal(decision.reasonCodes.includes("TOKEN_SECURITY_MISSING"), true);
});
