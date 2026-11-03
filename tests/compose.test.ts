import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("compose defaults services to DRY_RUN, persists storage, and keeps Telegram optional and unpublished", async () => {
  const compose = parse(await readFile("docker-compose.yml", "utf8")) as {
    services?: Record<
      string,
      {
        environment?: Record<string, string>;
        ports?: string[];
        read_only?: boolean;
        volumes?: string[];
        profiles?: string[];
        cap_drop?: string[];
        security_opt?: string[];
        depends_on?: Record<string, { condition?: string } | string>;
      }
    >;
    volumes?: Record<string, unknown>;
  };
  assert.ok(compose.services?.["worker"]);
  assert.ok(compose.services?.["api"]);
  assert.ok(compose.services?.["telegram-bot"]);
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
  assert.equal(compose.services?.["telegram-bot"].ports, undefined);
  assert.deepEqual(compose.services?.["telegram-bot"].profiles, ["telegram"]);
  assert.equal(compose.services?.["telegram-bot"].read_only, true);
  assert.deepEqual(compose.services?.["telegram-bot"].cap_drop, ["ALL"]);
  assert.ok(
    compose.services?.["telegram-bot"].security_opt?.includes(
      "no-new-privileges:true",
    ),
  );
  assert.deepEqual(compose.services?.["telegram-bot"].volumes, [
    "sentinel-data:/app/data",
  ]);
  assert.equal(
    compose.services?.["telegram-bot"].depends_on?.["api"] &&
      typeof compose.services?.["telegram-bot"].depends_on?.["api"] === "object"
      ? compose.services["telegram-bot"].depends_on["api"].condition
      : undefined,
    "service_healthy",
  );
  assert.ok(Object.hasOwn(compose.volumes ?? {}, "sentinel-data"));
});
