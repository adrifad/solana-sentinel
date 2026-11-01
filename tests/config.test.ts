import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "@sentinel/config";

test("loads safe DRY_RUN defaults without wallet credentials", async () => {
  const loaded = await loadConfig({
    APP_CONFIG_PATH: "config/default.yaml",
    DB_PATH: ":memory:",
  });
  assert.equal(loaded.config.mode, "DRY_RUN");
  assert.equal(loaded.pumpPortalApiKey, undefined);
  assert.equal(loaded.heliusApiKey, undefined);
  assert.match(loaded.configVersion, /^[a-f0-9]{64}$/);
});

test("rejects PAPER/LIVE modes and malformed configuration", async () => {
  await assert.rejects(() => loadConfig({ APP_MODE: "LIVE" }), /DRY_RUN only/);
  const path = await mkdtemp(join(tmpdir(), "sentinel-config-"));
  const file = join(path, "bad.yaml");
  const baseline = await readFile("config/default.yaml", "utf8");
  await writeFile(file, baseline.replace("mode: DRY_RUN", "mode: LIVE"));
  await assert.rejects(() => loadConfig({ APP_CONFIG_PATH: file }));
  await rm(path, { recursive: true, force: true });
});

test("rejects unsupported settings and bad ports", async () => {
  await assert.rejects(() => loadConfig({ API_PORT: "70000" }), /API_PORT/);
  const path = await mkdtemp(join(tmpdir(), "sentinel-config-"));
  const file = join(path, "bad.yaml");
  const baseline = await readFile("config/default.yaml", "utf8");
  await writeFile(file, `${baseline}\nwallet_private_key: "secret"\n`);
  await assert.rejects(() => loadConfig({ APP_CONFIG_PATH: file }));
  await rm(path, { recursive: true, force: true });
});
