import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve("README.md");
const markdown = readFileSync(readmePath, "utf8");
const missing = [];
for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
  const destination = match[1]?.trim().replace(/^<|>$/g, "");
  if (!destination || /^(?:https?:|mailto:|#)/i.test(destination)) continue;
  const target = destination.split(/[?#]/, 1)[0];
  if (target && !existsSync(resolve(target))) missing.push(target);
}
if (missing.length > 0) {
  process.stderr.write(
    `Broken README references:\n${[...new Set(missing)].join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("README local references: ok\n");
}
