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

test("accepts explicit PAPER mode, rejects LIVE, and validates configuration", async () => {
  assert.equal((await loadConfig({ APP_MODE: "PAPER" })).config.mode, "PAPER");
  await assert.rejects(
    () => loadConfig({ APP_MODE: "LIVE" }),
    /LIVE is unsupported/,
  );
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

  const capacityPath = await mkdtemp(join(tmpdir(), "sentinel-capacity-"));
  const capacityFile = join(capacityPath, "bad-capacity.yaml");
  const valid = await readFile("config/default.yaml", "utf8");
  await writeFile(
    capacityFile,
    valid.replace("max_pending_events: 128", "max_pending_events: 0"),
  );
  await assert.rejects(() => loadConfig({ APP_CONFIG_PATH: capacityFile }));
  await rm(capacityPath, { recursive: true, force: true });
});
