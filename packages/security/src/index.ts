import { base58Encode } from "@sentinel/domain";

export const LEGACY_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type MintExtension = {
  typeId: number;
  name: string;
  classification: "SUPPORTED" | "RISK" | "UNSUPPORTED";
};

export type DecodedMint = {
  status: "SUPPORTED" | "UNSUPPORTED" | "MISSING" | "UNSAFE";
  programId: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: string | null;
  decimals: number | null;
  extensions: MintExtension[];
  reasonCodes: string[];
  confidenceBps: number;
};

export type TestTokenAssessment = {
  classification: "LIKELY_TEST" | "UNKNOWN";
  confidenceBps: number;
  reasonCodes: string[];
};

export function assessTestTokenMetadata(input: {
  name: string | null;
  symbol: string | null;
  uri: string | null;
}): TestTokenAssessment {
  const values = [input.name, input.symbol, input.uri].filter(
    (value): value is string => value !== null,
  );
  const pattern =
    /(^|[^a-z0-9])(test(?:net)?|devnet|sample|demo|fake|example)([^a-z0-9]|$)/i;
  const matched = values.some((value) => pattern.test(value));
  return matched
    ? {
        classification: "LIKELY_TEST",
        confidenceBps: 7000,
        reasonCodes: ["TEST_TOKEN_METADATA_PATTERN"],
      }
    : { classification: "UNKNOWN", confidenceBps: 0, reasonCodes: [] };
}

const EXTENSIONS = new Map<
  number,
  { name: string; classification: MintExtension["classification"] }
>([
  [1, { name: "TRANSFER_FEE_CONFIG", classification: "RISK" }],
  [3, { name: "MINT_CLOSE_AUTHORITY", classification: "RISK" }],
  [4, { name: "CONFIDENTIAL_TRANSFER_MINT", classification: "UNSUPPORTED" }],
  [6, { name: "DEFAULT_ACCOUNT_STATE", classification: "RISK" }],
  [9, { name: "NON_TRANSFERABLE", classification: "RISK" }],
  [10, { name: "INTEREST_BEARING_CONFIG", classification: "SUPPORTED" }],
  [12, { name: "PERMANENT_DELEGATE", classification: "RISK" }],
  [14, { name: "TRANSFER_HOOK", classification: "UNSUPPORTED" }],
  [18, { name: "METADATA_POINTER", classification: "SUPPORTED" }],
  [19, { name: "TOKEN_METADATA", classification: "SUPPORTED" }],
  [20, { name: "GROUP_POINTER", classification: "SUPPORTED" }],
  [21, { name: "TOKEN_GROUP", classification: "SUPPORTED" }],
  [22, { name: "GROUP_MEMBER_POINTER", classification: "SUPPORTED" }],
  [23, { name: "TOKEN_GROUP_MEMBER", classification: "SUPPORTED" }],
  [24, { name: "CONFIDENTIAL_MINT_BURN", classification: "UNSUPPORTED" }],
  [25, { name: "SCALED_UI_AMOUNT", classification: "RISK" }],
  [26, { name: "PAUSABLE", classification: "RISK" }],
  [28, { name: "PERMISSIONED_BURN", classification: "RISK" }],
]);

export function decodeMintAccount(
  programId: string | null,
  dataBase64: string | null,
): DecodedMint {
  if (!programId || !dataBase64)
    return emptyMint("MISSING", "MINT_ACCOUNT_MISSING", programId);
  if (
    programId !== LEGACY_TOKEN_PROGRAM_ID &&
    programId !== TOKEN_2022_PROGRAM_ID
  )
    return emptyMint("UNSUPPORTED", "TOKEN_PROGRAM_UNSUPPORTED", programId);
  let data: Buffer;
  try {
    data = Buffer.from(dataBase64, "base64");
    if (data.toString("base64") !== dataBase64)
      return emptyMint("UNSUPPORTED", "MINT_DATA_INVALID_BASE64", programId);
  } catch {
    return emptyMint("UNSUPPORTED", "MINT_DATA_INVALID_BASE64", programId);
  }
  if (data.length < 82)
    return emptyMint("UNSUPPORTED", "MINT_DATA_TOO_SHORT", programId);
  const mintAuthority = readCOptionPubkey(data, 0);
  const supply = data.readBigUInt64LE(36);
  const decimals = data[44];
  const initialized = data[45];
  const freezeAuthority = readCOptionPubkey(data, 46);
  if (
    mintAuthority === undefined ||
    freezeAuthority === undefined ||
    decimals === undefined ||
    initialized === undefined
  )
    return emptyMint("UNSUPPORTED", "MINT_LAYOUT_INVALID", programId);
  if (initialized !== 1)
    return emptyMint("UNSAFE", "MINT_NOT_INITIALIZED", programId);

  let extensions: MintExtension[] = [];
  const reasons: string[] = [];
  if (programId === LEGACY_TOKEN_PROGRAM_ID) {
    if (data.length !== 82)
      return emptyMint("UNSUPPORTED", "LEGACY_MINT_LAYOUT_INVALID", programId);
  } else if (data.length !== 82) {
    if (data.length < 166 || data[165] !== 1)
      return emptyMint("UNSUPPORTED", "TOKEN_2022_LAYOUT_INVALID", programId);
    if (data.subarray(82, 165).some((byte) => byte !== 0))
      return emptyMint("UNSUPPORTED", "TOKEN_2022_PADDING_INVALID", programId);
    const result = parseMintTlv(data.subarray(166));
    if (!result.ok)
      return emptyMint("UNSUPPORTED", "TOKEN_2022_TLV_INVALID", programId);
    extensions = result.extensions;
    if (result.hasUnknown) reasons.push("TOKEN_EXTENSION_UNSUPPORTED");
    for (const extension of extensions) {
      if (extension.classification === "UNSUPPORTED")
        reasons.push(`${extension.name}_UNSUPPORTED`);
      else if (extension.classification === "RISK")
        reasons.push(`${extension.name}_PRESENT`);
    }
  }
  if (mintAuthority) reasons.push("MINT_AUTHORITY_ACTIVE");
  if (freezeAuthority) reasons.push("FREEZE_AUTHORITY_ACTIVE");
  const unsafeExtension = extensions.some(
    (extension) => extension.classification === "RISK",
  );
  const unsupportedExtension = extensions.some(
    (extension) => extension.classification === "UNSUPPORTED",
  );
  const status =
    unsafeExtension || mintAuthority || freezeAuthority
      ? "UNSAFE"
      : unsupportedExtension
        ? "UNSUPPORTED"
        : "SUPPORTED";
  return {
    status,
    programId,
    mintAuthority,
    freezeAuthority,
    supplyRaw: supply.toString(),
    decimals,
    extensions,
    reasonCodes: [...new Set(reasons)].sort(),
    confidenceBps: 10000,
  };
}

function parseMintTlv(
  data: Buffer,
):
  | { ok: true; extensions: MintExtension[]; hasUnknown: boolean }
  | { ok: false } {
  let offset = 0;
  const extensions: MintExtension[] = [];
  let hasUnknown = false;
  while (offset < data.length) {
    if (data.length - offset < 2)
      return data.subarray(offset).every((byte) => byte === 0)
        ? { ok: true, extensions, hasUnknown }
        : { ok: false };
    const typeId = data.readUInt16LE(offset);
    if (typeId === 0)
      return data.subarray(offset).every((byte) => byte === 0)
        ? { ok: true, extensions, hasUnknown }
        : { ok: false };
    if (offset + 4 > data.length) return { ok: false };
    const length = data.readUInt16LE(offset + 2);
    const valueStart = offset + 4;
    if (valueStart + length > data.length) return { ok: false };
    const extension = EXTENSIONS.get(typeId);
    if (!extension) {
      hasUnknown = true;
      extensions.push({
        typeId,
        name: `UNKNOWN_EXTENSION_${typeId}`,
        classification: "UNSUPPORTED",
      });
    } else if ([2, 5, 7, 8, 11, 13, 15, 16, 17, 27].includes(typeId)) {
      return { ok: false };
    } else {
      extensions.push({ typeId, ...extension });
      if (typeId === 6 && length === 1 && data[valueStart] === 2)
        extensions[extensions.length - 1] = {
          typeId,
          name: "DEFAULT_ACCOUNT_STATE_FROZEN",
          classification: "RISK",
        };
    }
    offset = valueStart + length;
  }
  return { ok: true, extensions, hasUnknown };
}

function readCOptionPubkey(
  data: Buffer,
  offset: number,
): string | null | undefined {
  if (offset + 36 > data.length) return undefined;
  const option = data.readUInt32LE(offset);
  if (option === 0) return null;
  if (option !== 1) return undefined;
  return base58Encode(data.subarray(offset + 4, offset + 36));
}

function emptyMint(
  status: DecodedMint["status"],
  reasonCode: string,
  programId: string | null,
): DecodedMint {
  return {
    status,
    programId,
    mintAuthority: null,
    freezeAuthority: null,
    supplyRaw: null,
    decimals: null,
    extensions: [],
    reasonCodes: [reasonCode],
    confidenceBps: 0,
  };
}

export function ratioBps(part: bigint, whole: bigint): number | null {
  if (part < 0n || whole <= 0n) return null;
  if (part >= whole) return 10000;
  return Number((part * 10000n) / whole);
}
