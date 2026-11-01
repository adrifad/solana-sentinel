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

test("Helius validates finalized wallet history pages and transaction identity", async () => {
  const signature =
    "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2";
  const wallet = "So11111111111111111111111111111111111111112";
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const client = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      requests.push(request);
      return request.method === "getSignaturesForAddress"
        ? Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: [
              { signature, slot: 42, err: null, blockTime: 1_700_000_000 },
            ],
          })
        : Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              slot: 42,
              blockTime: 1_700_000_000,
              transaction: {
                signatures: [signature],
                message: {
                  accountKeys: [
                    { pubkey: wallet, signer: true, writable: true },
                  ],
                  instructions: [],
                },
              },
              meta: {
                err: null,
                fee: 5000,
                logMessages: [],
                preBalances: [100],
                postBalances: [95],
              },
            },
          });
    },
  });
  const page = await client.getSignaturesForAddress(wallet, { limit: 10 });
  assert.deepEqual(page, [
    { signature, slot: 42, succeeded: true, blockTime: 1_700_000_000 },
  ]);
  const transaction = await client.getTransaction(signature);
  assert.equal(transaction?.signature, signature);
  assert.equal(transaction?.feeLamports, 5000);
  assert.equal(requests[0]?.method, "getSignaturesForAddress");
  assert.equal(requests[1]?.method, "getTransaction");
  assert.deepEqual(
    (requests[1]?.params[1] as Record<string, unknown>)?.["commitment"],
    "finalized",
  );
});

test("Helius rejects a transaction whose returned signature differs from the request", async () => {
  const requested =
    "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2";
  const different = "1".repeat(64);
  const client = new HeliusRpcClient({
    apiKey: "test",
    requestTimeoutMs: 1000,
    fetchImpl: async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          slot: 42,
          blockTime: null,
          transaction: {
            signatures: [different],
            message: { accountKeys: [], instructions: [] },
          },
          meta: { err: null, fee: 0, logMessages: [] },
        },
      }),
  });
  await assert.rejects(
    () => client.getTransaction(requested),
    (error: unknown) => (error as Error).message === "MALFORMED_RESPONSE",
  );
});

test("Helius aborts timed-out wallet history requests and reports a safe timeout code", async () => {
  const signature =
    "5TKad77QinBX7wpSJABiiH2w7FnSgseEHdjTzTHgT9bcYJAa9xrKyTTfVHifoXXqHZdy1wBfbFHmrVCebBBsfev2";
  let attempts = 0;
  const client = new HeliusRpcClient({
    apiKey: "timeout-test-secret",
    requestTimeoutMs: 100,
    fetchImpl: async (_url, init) => {
      attempts += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  });
  await assert.rejects(
    () => client.getTransaction(signature),
    (error: unknown) => {
      assert.equal((error as Error).message, "TIMEOUT");
      assert.doesNotMatch((error as Error).message, /timeout-test-secret/);
      return true;
    },
  );
  assert.equal(attempts, 3);
});
