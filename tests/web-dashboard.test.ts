import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAge,
  formatReason,
  formatSol,
  shortMint,
} from "../apps/web/src/lib/format.ts";

test("dashboard formats exact lamport balances without floating point", () => {
  assert.equal(formatSol("10000000000"), "10 SOL");
  assert.equal(formatSol("500000000"), "0.5 SOL");
  assert.equal(formatSol("123456789"), "0.123456789 SOL");
  assert.equal(formatSol("-1250000000"), "−1.25 SOL");
  assert.equal(formatSol("not-a-number"), "—");
});

test("dashboard keeps candidate identifiers legible and reason codes readable", () => {
  assert.equal(shortMint("12345678901234567890"), "123456…67890");
  assert.equal(shortMint("shortmint"), "shortmint");
  assert.equal(
    formatReason("TRADE_STREAM_COVERAGE_UNVERIFIED"),
    "Trade Stream Coverage Unverified",
  );
  assert.equal(formatReason(null), "No blocker recorded");
});

test("dashboard labels missing and invalid timestamps without inventing age", () => {
  assert.equal(formatAge(null), "not observed");
  assert.equal(formatAge("not-a-time"), "time unknown");
  assert.equal(
    formatAge(new Date(Date.now() + 60_000).toISOString()),
    "time unknown",
  );
});
