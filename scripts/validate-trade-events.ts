import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@sentinel/config";
import { PubkeySchema, utcNow } from "@sentinel/domain";
import {
  decodePumpSwapTradeEvents,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  validateTradeTransaction,
} from "@sentinel/intelligence";
import { HeliusRpcClient, PumpSwapStateLoader } from "@sentinel/providers";
import type { VerifiedTradeObservation } from "@sentinel/intelligence";

type Args = {
  mint: string | null;
  maxSignatures: number;
  capture: string | null;
};

export function parseTradeValidationArgs(argv: string[]): Args {
  const result: Args = { mint: null, maxSignatures: 5, capture: null };
  for (const arg of argv) {
    if (arg.startsWith("--mint=")) result.mint = arg.slice("--mint=".length);
    else if (arg.startsWith("--max-signatures=")) {
      const max = Number(arg.slice("--max-signatures=".length));
      if (!Number.isSafeInteger(max) || max < 1 || max > 20)
        throw new Error("MAX_SIGNATURES_MUST_BE_1_TO_20");
      result.maxSignatures = max;
    } else if (arg.startsWith("--capture=")) {
      result.capture = arg.slice("--capture=".length);
      const target = resolve(result.capture);
      if (
        !target.startsWith(resolve("tests/fixtures/captures") + "/") ||
        !target.endsWith(".json")
      )
        throw new Error("CAPTURE_PATH_MUST_BE_UNDER_TEST_FIXTURES_CAPTURES");
    } else throw new Error("UNKNOWN_ARGUMENT");
  }
  if (result.mint && !PubkeySchema.safeParse(result.mint).success)
    throw new Error("INVALID_MINT");
  return result;
}

export async function runTradeEventValidation(argv = process.argv.slice(2)) {
  const args = parseTradeValidationArgs(argv);
  if (!args.mint)
    return { status: "BLOCKED", reasonCode: "MINT_ARGUMENT_REQUIRED" };
  const config = await loadConfig();
  if (!config.heliusApiKey)
    return { status: "BLOCKED", reasonCode: "HELIUS_API_KEY_MISSING" };
  let requestCount = 0;
  const requestCap = 1 + args.maxSignatures + 2;
  const helius = new HeliusRpcClient({
    apiKey: config.heliusApiKey,
    requestTimeoutMs: config.config.providers.helius.request_timeout_ms,
    maxRequestsPerSecond:
      config.config.providers.helius.max_requests_per_second,
    consumeRequestBudget: () => {
      if (requestCount >= requestCap) return false;
      requestCount += 1;
      return true;
    },
  });
  let page: Awaited<ReturnType<HeliusRpcClient["getSignaturesForAddress"]>>;
  try {
    page = await helius.getSignaturesForAddress(args.mint, {
      limit: args.maxSignatures,
    });
  } catch (error) {
    return {
      status: "BLOCKED",
      reasonCode: safeProviderErrorCode(error),
      mint: args.mint,
      requestCount,
      requestCap,
      signaturesExamined: 0,
    };
  }
  const pumpSwapState = new PumpSwapStateLoader({ helius });
  const observations: VerifiedTradeObservation[] = [];
  const evidence: Array<{
    signature: string;
    slot: number;
    blockTime: number | null;
    succeeded: boolean;
    validationStatus: string;
    reasonCode: string | null;
    observations: VerifiedTradeObservation[];
    sanitizedProgramLogs: string[];
  }> = [];
  let pumpSwapStateChecked = false;
  let pumpSwapPools:
    Map<string, { baseMint: string; quoteMint: string }> | undefined;
  try {
    for (const signature of page) {
      const transaction = await helius.getTransaction(signature.signature);
      if (
        !pumpSwapStateChecked &&
        transaction &&
        decodePumpSwapTradeEvents(transaction.logMessages).length
      ) {
        pumpSwapStateChecked = true;
        const state = await pumpSwapState.load(args.mint);
        if (state.status === "SUPPORTED")
          pumpSwapPools = new Map([
            [
              state.poolAddress,
              {
                baseMint: state.state.pool.baseMint.toBase58(),
                quoteMint: state.state.pool.quoteMint.toBase58(),
              },
            ],
          ]);
      }
      const result = validateTradeTransaction({
        mint: args.mint,
        signature: signature.signature,
        providerSlot: signature.slot,
        receivedAtUtc: utcNow(),
        transaction,
        ...(pumpSwapPools ? { pumpSwapPools } : {}),
      });
      if (result.status === "VERIFIED")
        observations.push(...result.observations);
      evidence.push({
        signature: signature.signature,
        slot: signature.slot,
        blockTime: transaction?.blockTime ?? signature.blockTime,
        succeeded: transaction?.succeeded ?? signature.succeeded,
        validationStatus: result.status,
        reasonCode: result.reasonCode,
        observations: result.observations,
        sanitizedProgramLogs:
          result.status === "VERIFIED"
            ? (transaction?.logMessages
                .filter(
                  (line) =>
                    line === `Program ${PUMP_PROGRAM_ID} invoke [1]` ||
                    line === `Program ${PUMP_PROGRAM_ID} success` ||
                    line === `Program ${PUMPSWAP_PROGRAM_ID} invoke [1]` ||
                    line === `Program ${PUMPSWAP_PROGRAM_ID} success` ||
                    line.startsWith("Program data: "),
                )
                .slice(0, 100) ?? [])
            : [],
      });
      if (observations.length > 0) break;
    }
  } catch (error) {
    return {
      status: "BLOCKED",
      reasonCode: safeProviderErrorCode(error),
      mint: args.mint,
      requestCount,
      requestCap,
      signaturesExamined: evidence.length,
    };
  }
  const report = {
    captureSource: "HELIUS_FINALIZED_ADDRESS_SIGNATURES_AND_GET_TRANSACTION",
    validatedAtUtc: utcNow(),
    mint: args.mint,
    requestCount,
    requestCap,
    signaturesExamined: evidence.length,
    status:
      observations.length > 0
        ? "LIVE_TRADE_EVENT_VALIDATED"
        : "LIVE_TRADE_PAYLOAD_NOT_VALIDATED",
    evidence,
  };
  if (args.capture && observations.length > 0) {
    const target = resolve(args.capture);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return report;
}

function safeProviderErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "PROVIDER_UNAVAILABLE";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runTradeEventValidation().then(
    (report) => process.stdout.write(JSON.stringify(report, null, 2) + "\n"),
    (error: unknown) => {
      process.stderr.write(
        JSON.stringify({
          status: "BLOCKED",
          reasonCode: safeProviderErrorCode(error),
        }) + "\n",
      );
      process.exitCode = 1;
    },
  );
}
