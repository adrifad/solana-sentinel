import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@sentinel/config";
import {
  decodePumpCreateEvents,
  transactionFeePayer,
} from "@sentinel/intelligence";
import {
  HeliusRpcClient,
  PumpPortalClient,
  PumpCurveStateLoader,
  PumpSwapStateLoader,
} from "@sentinel/providers";
import type { MarketEvent } from "@sentinel/domain";

type Args = {
  seconds: number;
  capture: string | null;
  captureState: string | null;
  capturePumpSwapState: string | null;
  pumpSwapMint: string | null;
  skipPumpPortal: boolean;
  skipHelius: boolean;
};

export function parseArgs(argv: string[]): Args {
  const result: Args = {
    seconds: 45,
    capture: null,
    captureState: null,
    capturePumpSwapState: null,
    pumpSwapMint: null,
    skipPumpPortal: false,
    skipHelius: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--seconds=")) {
      const seconds = Number(arg.slice("--seconds=".length));
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
        throw new Error("SECONDS_MUST_BE_1_TO_300");
      result.seconds = seconds;
    } else if (arg.startsWith("--capture=")) {
      result.capture = arg.slice("--capture=".length);
    } else if (arg.startsWith("--capture-state=")) {
      result.captureState = arg.slice("--capture-state=".length);
    } else if (arg.startsWith("--capture-pumpswap-state=")) {
      result.capturePumpSwapState = arg.slice(
        "--capture-pumpswap-state=".length,
      );
    } else if (arg.startsWith("--pumpswap-mint=")) {
      result.pumpSwapMint = arg.slice("--pumpswap-mint=".length);
    } else if (arg === "--no-pumpportal") result.skipPumpPortal = true;
    else if (arg === "--no-helius") result.skipHelius = true;
    else throw new Error("UNKNOWN_ARGUMENT");
  }
  if (result.capturePumpSwapState && !result.pumpSwapMint)
    throw new Error("PUMPSWAP_MINT_REQUIRED_FOR_STATE_CAPTURE");
  for (const capturePath of [
    result.capture,
    result.captureState,
    result.capturePumpSwapState,
  ]) {
    if (!capturePath) continue;
    const target = resolve(capturePath);
    const allowedRoot = resolve("tests/fixtures/captures") + "/";
    if (!target.startsWith(allowedRoot) || !target.endsWith(".json"))
      throw new Error("CAPTURE_PATH_MUST_BE_UNDER_TEST_FIXTURES_CAPTURES");
  }
  return result;
}

export function makePublicCapture(event: MarketEvent, capturedAtUtc: string) {
  return {
    captureSource: "LIVE_PUMPPORTAL_WEBSOCKET",
    providerContract: "observed-live-message",
    capturedAtUtc,
    event: {
      provider: event.provider,
      kind: event.kind,
      mint: event.mint,
      txSignature: event.txSignature ?? null,
      slot: event.slot ?? null,
      receivedAtUtc: event.receivedAtUtc,
      creator: event.creator ?? null,
      launchInitiator: event.launchInitiator ?? null,
      name: event.name ?? null,
      symbol: event.symbol ?? null,
      rawPayloadRef: event.rawPayloadRef,
      sanitizedPayload: event.sanitizedPayload,
    },
  };
}

async function validateHelius(
  config: Awaited<ReturnType<typeof loadConfig>>,
  captureStatePath: string | null,
  capturePumpSwapStatePath: string | null,
  pumpSwapMint: string | null,
) {
  if (!config.heliusApiKey)
    return { status: "BLOCKED", reason: "HELIUS_API_KEY_MISSING" };
  let consumed = 0;
  const maxRequests =
    4 + (captureStatePath ? 1 : 0) + (capturePumpSwapStatePath ? 2 : 0);
  const client = new HeliusRpcClient({
    apiKey: config.heliusApiKey,
    requestTimeoutMs: config.config.providers.helius.request_timeout_ms,
    maxRequestsPerSecond:
      config.config.providers.helius.max_requests_per_second,
    consumeRequestBudget: () => consumed++ < maxRequests,
  });
  const health = await client.getHealth();
  const referenceFixture = JSON.parse(
    await readFile(
      "tests/fixtures/pumpportal-created.mainnet.capture.json",
      "utf8",
    ),
  ) as { signature: string; mint: string; bondingCurveKey: string };
  let fixture = referenceFixture;
  let captureType = "SANITIZED_REFERENCE_FIXTURE";
  let initiatorClaim: string | null = null;
  try {
    const liveCapture = JSON.parse(
      await readFile(
        "tests/fixtures/captures/pumpportal-create-2026-11-01.json",
        "utf8",
      ),
    ) as Array<{
      event?: {
        mint?: string;
        txSignature?: string | null;
        sanitizedPayload?: string;
      };
    }>;
    const event = liveCapture[0]?.event;
    const raw = event?.sanitizedPayload
      ? (JSON.parse(event.sanitizedPayload) as Record<string, unknown>)
      : null;
    if (
      event?.mint &&
      event.txSignature &&
      typeof raw?.["bondingCurveKey"] === "string"
    ) {
      fixture = {
        signature: event.txSignature,
        mint: event.mint,
        bondingCurveKey: raw["bondingCurveKey"],
      };
      initiatorClaim =
        typeof raw["traderPublicKey"] === "string"
          ? raw["traderPublicKey"]
          : null;
      captureType = "LIVE_PUMPPORTAL_CAPTURE";
    }
  } catch {
    // The committed public reference fixture is used until a live capture exists.
  }
  const transaction = await client.getTransaction(fixture.signature);
  const accounts = await client.getMultipleAccounts([
    fixture.mint,
    fixture.bondingCurveKey,
  ]);
  let curveState:
    | {
        status: string;
        reasonCode?: string;
        slot?: number;
        source?: string;
        stateRef?: string;
      }
    | undefined;
  let pumpSwapState:
    | {
        status: string;
        reasonCode?: string;
        slot?: number;
        poolAddress?: string;
        slotSkew?: number;
      }
    | undefined;
  if (captureStatePath) {
    let rawSnapshot:
      | Parameters<
          NonNullable<
            ConstructorParameters<
              typeof PumpCurveStateLoader
            >[0]["onRawSnapshot"]
          >
        >[0]
      | undefined;
    const loaded = await new PumpCurveStateLoader({
      helius: client,
      onRawSnapshot(snapshot) {
        rawSnapshot = snapshot;
      },
    }).load(fixture.mint);
    curveState =
      loaded.status === "SUPPORTED"
        ? {
            status: loaded.status,
            slot: loaded.state.snapshot.slot,
            source: loaded.state.snapshot.source,
            stateRef: loaded.state.snapshot.stateRef,
          }
        : { status: loaded.status, reasonCode: loaded.reasonCode };
    if (rawSnapshot) {
      const target = resolve(captureStatePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        JSON.stringify(
          {
            captureSource: "HELIUS_CONFIRMED_GET_MULTIPLE_ACCOUNTS",
            capturedAtUtc: new Date().toISOString(),
            mint: fixture.mint,
            decodedState: curveState,
            slot: rawSnapshot.slot,
            accounts: rawSnapshot.accounts,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    }
  }
  if (capturePumpSwapStatePath && pumpSwapMint) {
    let rawSnapshot:
      | Parameters<
          NonNullable<
            ConstructorParameters<
              typeof PumpSwapStateLoader
            >[0]["onRawSnapshot"]
          >
        >[0]
      | undefined;
    const loaded = await new PumpSwapStateLoader({
      helius: client,
      onRawSnapshot(snapshot) {
        rawSnapshot = snapshot;
      },
    }).load(pumpSwapMint);
    pumpSwapState =
      loaded.status === "SUPPORTED"
        ? {
            status: loaded.status,
            slot: loaded.state.snapshot.slot,
            poolAddress: loaded.poolAddress,
            slotSkew: loaded.slotSkew,
          }
        : { status: loaded.status, reasonCode: loaded.reasonCode };
    if (rawSnapshot) {
      const target = resolve(capturePumpSwapStatePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        JSON.stringify(
          {
            captureSource: "HELIUS_CONFIRMED_PUMPSWAP_STATE",
            capturedAtUtc: new Date().toISOString(),
            mint: pumpSwapMint,
            decodedState: pumpSwapState,
            slot: rawSnapshot.slot,
            poolAddress: rawSnapshot.poolAddress,
            accounts: rawSnapshot.accounts,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    }
  }
  const creates = transaction
    ? decodePumpCreateEvents(transaction.logMessages)
    : [];
  const create = creates.find((item) => item.mint === fixture.mint);
  return {
    status: health.ok && transaction?.succeeded ? "PASS" : "DEGRADED",
    liveHealth: health.ok,
    genesisMatchesMainnet:
      health.genesisHash === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    historicalFixtureTransaction: {
      found: transaction !== null,
      succeeded: transaction?.succeeded ?? false,
      slot: transaction?.slot ?? null,
      feePayer: transaction ? transactionFeePayer(transaction) : null,
      providerInitiatorMatchesFeePayer:
        transaction && initiatorClaim
          ? transactionFeePayer(transaction) === initiatorClaim
          : null,
      createEventDecoded: create !== undefined,
      createEventMintMatches: create?.mint === fixture.mint,
      createEventUser: create?.user ?? null,
      createEventCreator: create?.creator ?? null,
    },
    accountState: {
      contextSlot: accounts.slot,
      mintExists: accounts.accounts[0] !== null,
      mintOwner: accounts.accounts[0]?.owner ?? null,
      bondingCurveExists: accounts.accounts[1] !== null,
      bondingCurveOwner: accounts.accounts[1]?.owner ?? null,
    },
    evidenceSource: captureType,
    pumpCurveState: curveState ?? "NOT_REQUESTED",
    pumpSwapState: pumpSwapState ?? "NOT_REQUESTED",
    requestsConsumed: consumed,
    requestCap: maxRequests,
  };
}

async function validatePumpPortal(
  config: Awaited<ReturnType<typeof loadConfig>>,
  seconds: number,
  capturePath: string | null,
) {
  if (!config.pumpPortalApiKey)
    return { status: "BLOCKED", reason: "PUMPPORTAL_API_KEY_MISSING" };
  const events: ReturnType<typeof makePublicCapture>[] = [];
  let state = "STARTING";
  let errorCode: string | null = null;
  const client = new PumpPortalClient({
    apiKey: config.pumpPortalApiKey,
    enableNewTokens: true,
    enableMigrations: true,
    maxPendingEvents: config.config.providers.pumpportal.max_pending_events,
    eventProcessingConcurrency:
      config.config.providers.pumpportal.event_processing_concurrency,
    onHealth(nextState, _reconnects, nextError) {
      state = nextState;
      errorCode = nextError;
    },
    persistEvent(event) {
      if (events.length < 20)
        events.push(makePublicCapture(event, new Date().toISOString()));
    },
    async onEvent() {},
  });
  const loop = client.start();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, seconds * 1000));
  await client.stop();
  await loop;
  if (capturePath && events.length > 0) {
    const target = resolve(capturePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(events, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return {
    status: state === "STOPPED" && events.length > 0 ? "PASS" : "INCOMPLETE",
    finalSocketState: state,
    errorCode,
    freeFeedEventsObserved: events.length,
    creationEvents: events.filter((item) => item.event.kind === "TOKEN_CREATED")
      .length,
    migrationEvents: events.filter(
      (item) => item.event.kind === "TOKEN_MIGRATED",
    ).length,
    meteredTradeStream: "NOT_REQUESTED",
    captureWritten: Boolean(capturePath && events.length > 0),
  };
}

export async function runValidation(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadConfig();
  const result: Record<string, unknown> = {
    validationStartedAtUtc: new Date().toISOString(),
    credentialsPresent: {
      helius: Boolean(config.heliusApiKey),
      pumpportal: Boolean(config.pumpPortalApiKey),
    },
  };
  if (!args.skipHelius)
    result["helius"] = await validateHelius(
      config,
      args.captureState,
      args.capturePumpSwapState,
      args.pumpSwapMint,
    );
  if (!args.skipPumpPortal)
    result["pumpportal"] = await validatePumpPortal(
      config,
      args.seconds,
      args.capture,
    );
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runValidation().then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
    (error: unknown) => {
      process.stderr.write(
        JSON.stringify({
          status: "FAILED",
          errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        }) + "\n",
      );
      process.exitCode = 1;
    },
  );
}
