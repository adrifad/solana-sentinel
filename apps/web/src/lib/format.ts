const LAMPORTS_PER_SOL = 1_000_000_000n;

export function formatSol(value: string | null | undefined): string {
  if (!value || !/^-?\d+$/.test(value)) return "—";
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} SOL`;
}

export function shortMint(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

export function formatAge(value: string | null | undefined): string {
  if (!value) return "not observed";
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "time unknown";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

export function formatReason(value: string | null | undefined): string {
  if (!value) return "No blocker recorded";
  return value
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
