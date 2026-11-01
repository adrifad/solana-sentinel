type Level = "info" | "warn" | "error";
export function log(
  level: Level,
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ level, event, atUtc: new Date().toISOString(), ...fields })}\n`,
  );
}
