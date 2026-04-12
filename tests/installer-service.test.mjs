import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const service = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "service.js"))
    .href
);

test("installer service helpers build systemd service spec", () => {
  const spec = service.buildSystemdUserService(
    "demo",
    "/tmp/rin",
    () => "/home/demo",
    () => "/repo",
  );
  assert.equal(spec.kind, "systemd");
  assert.ok(spec.service.includes("Environment=RIN_DIR=/tmp/rin"));
  assert.ok(spec.servicePath.includes(path.join(".config", "systemd", "user")));
});
