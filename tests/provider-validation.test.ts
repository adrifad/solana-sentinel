import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseArgs } from "../scripts/validate-providers.ts";
import { parseTradeValidationArgs } from "../scripts/validate-trade-events.ts";
import { parsePumpPortalMessage } from "@sentinel/providers";

test("provider validation uses a bounded duration and safe capture directory", () => {
  assert.deepEqual(parseArgs(["--seconds=30"]), {
    seconds: 30,
    capture: null,
    captureState: null,
    capturePumpSwapState: null,
    pumpSwapMint: null,
    skipPumpPortal: false,
    skipHelius: false,
  });
  assert.deepEqual(
    parseArgs(["--capture-state=tests/fixtures/captures/state.json"]),
    {
      seconds: 45,
      capture: null,
      captureState: "tests/fixtures/captures/state.json",
      capturePumpSwapState: null,
      pumpSwapMint: null,
      skipPumpPortal: false,
      skipHelius: false,
    },
  );
  assert.throws(() => parseArgs(["--seconds=301"]), /SECONDS_MUST_BE_1_TO_300/);
  assert.throws(
    () => parseArgs(["--capture=.env"]),
    /CAPTURE_PATH_MUST_BE_UNDER_TEST_FIXTURES_CAPTURES/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /UNKNOWN_ARGUMENT/);
});

test("trade validation harness enforces bounded RPC and capture arguments", () => {
  assert.deepEqual(
    parseTradeValidationArgs([
      "--mint=So11111111111111111111111111111111111111112",
      "--max-signatures=5",
    ]),
    {
      mint: "So11111111111111111111111111111111111111112",
      maxSignatures: 5,
      capture: null,
    },
  );
  assert.throws(
    () => parseTradeValidationArgs(["--max-signatures=21"]),
    /MAX_SIGNATURES_MUST_BE_1_TO_20/,
  );
  assert.throws(
    () =>
      parseTradeValidationArgs([
        "--mint=So11111111111111111111111111111111111111112",
        "--capture=.env",
      ]),
    /CAPTURE_PATH_MUST_BE_UNDER_TEST_FIXTURES_CAPTURES/,
  );
  assert.throws(
    () => parseTradeValidationArgs(["--unknown"]),
    /UNKNOWN_ARGUMENT/,
  );
});

test("public provider capture keeps only sanitized launch event fields", () => {
  const event = parsePumpPortalMessage({
    txType: "create",
    mint: "So11111111111111111111111111111111111111112",
    signature:
      "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2",
    apiKey: "must-not-be-retained",
  });
  const capture = JSON.stringify(event);
  assert.equal(capture.includes("must-not-be-retained"), false);
  assert.equal(capture.includes("[REDACTED]"), true);
  assert.equal(event.provider, "pumpportal");
  assert.equal(event.kind, "TOKEN_CREATED");
});

test("live PumpPortal launch capture retains its Helius verification provenance", async () => {
  const capture = JSON.parse(
    await readFile(
      "tests/fixtures/captures/pumpportal-create-2026-11-01.json",
      "utf8",
    ),
  ) as Array<{
    event: { mint: string; txSignature: string; sanitizedPayload: string };
  }>;
  const evidence = JSON.parse(
    await readFile(
      "tests/fixtures/captures/pumpportal-create-2026-11-01.evidence.json",
      "utf8",
    ),
  ) as {
    heliusVerification: {
      transactionSucceeded: boolean;
      createEventMint: string;
      slot: number;
      feePayer: string;
      createEventUser: string;
    };
  };
  const item = capture[0];
  assert.ok(item);
  const raw = JSON.parse(item.event.sanitizedPayload) as Record<
    string,
    unknown
  >;
  const normalized = parsePumpPortalMessage(raw);
  assert.equal(normalized.mint, item.event.mint);
  assert.equal(normalized.txSignature, item.event.txSignature);
  assert.equal(normalized.slot, undefined);
  assert.equal(evidence.heliusVerification.transactionSucceeded, true);
  assert.equal(evidence.heliusVerification.createEventMint, normalized.mint);
  assert.equal(evidence.heliusVerification.feePayer, raw["traderPublicKey"]);
  assert.equal(
    evidence.heliusVerification.createEventUser,
    raw["traderPublicKey"],
  );
  assert.equal(evidence.heliusVerification.slot, 464002088);
});
