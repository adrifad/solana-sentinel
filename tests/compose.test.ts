import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("compose defaults both services to DRY_RUN, persists storage, and publishes the API on loopback", async () => {
  const compose = parse(await readFile("docker-compose.yml", "utf8")) as {
    services?: Record<
      string,
      {
        environment?: Record<string, string>;
        ports?: string[];
        read_only?: boolean;
        volumes?: string[];
      }
    >;
    volumes?: Record<string, unknown>;
  };
  assert.ok(compose.services?.["worker"]);
  assert.ok(compose.services?.["api"]);
  assert.equal(
    compose.services?.["worker"].environment?.["APP_MODE"],
    "${APP_MODE:-DRY_RUN}",
  );
  assert.equal(
    compose.services?.["api"].environment?.["APP_MODE"],
    "${APP_MODE:-DRY_RUN}",
  );
  assert.equal(compose.services?.["worker"].read_only, true);
  assert.equal(compose.services?.["api"].ports?.[0], "127.0.0.1:8787:8787");
  assert.ok(Object.hasOwn(compose.volumes ?? {}, "sentinel-data"));
});
