import assert from "node:assert/strict";
import test from "node:test";
import { HeliusRpcClient } from "@sentinel/providers";

test("Helius validates account results and uses confirmed base64 getAccountInfo", async () => {
  let request: Record<string, unknown> | undefined;
  const client = new HeliusRpcClient({
    apiKey: "must-not-leak",
    requestTimeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 42 },
          value: {
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            data: ["AQID", "base64"],
            executable: false,
          },
        },
      });
    },
  });
  const result = await client.getAccountInfo(
    "So11111111111111111111111111111111111111112",
  );
  assert.equal(result.slot, 42);
  assert.equal(result.account?.dataBase64, "AQID");
  assert.equal(request?.["method"], "getAccountInfo");
});

test("Helius retries rate limits, sanitizes provider errors, and fails closed on malformed JSON-RPC", async () => {
  let count = 0;
  const client = new HeliusRpcClient({
    apiKey: "very-secret-key",
    requestTimeoutMs: 1000,
    fetchImpl: async () => {
      count += 1;
      return count < 3
        ? new Response("", { status: 429 })
        : Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { unexpected: true },
          });
    },
  });
  await assert.rejects(
    () => client.getAccountInfo("So11111111111111111111111111111111111111112"),
    (error: unknown) => {
      assert.equal((error as Error).message, "MALFORMED_RESPONSE");
      assert.doesNotMatch((error as Error).message, /very-secret-key/);
      return true;
    },
  );
  assert.equal(count, 3);
});

test("Helius derives chain time from documented block-time RPC results", async () => {
  const client = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      assert.equal(body.method, "getBlockTime");
      assert.deepEqual(body.params, [341197053]);
      return Response.json({ jsonrpc: "2.0", id: 1, result: 1793500000 });
    },
  });
  assert.equal(
    await client.getBlockTime(341197053),
    "2026-11-01T02:26:40.000Z",
  );
  assert.equal(
    await client.getBlockTime(-1).catch((error: Error) => error.message),
    "INVALID_SLOT",
  );
});
