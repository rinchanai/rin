import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const { BuiltinModuleHost, CompositeBuiltinRunner } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "builtins", "host.js"))
    .href
);

test("composite builtin runner exposes a merged createContext", () => {
  const builtinHost = new BuiltinModuleHost(
    "/tmp/rin-cwd",
    "/tmp/rin-agent",
    { name: "session-manager" },
    { name: "model-registry" },
  );
  const runner = new CompositeBuiltinRunner(
    {
      createContext() {
        return { externalOnly: true, cwd: "/external" };
      },
    },
    builtinHost,
  );

  const context = runner.createContext();

  assert.equal(context.externalOnly, true);
  assert.equal(context.cwd, "/tmp/rin-cwd");
  assert.equal(context.agentDir, "/tmp/rin-agent");
  assert.equal(context.sessionManager?.name, "session-manager");
  assert.equal(context.modelRegistry?.name, "model-registry");
  assert.equal(typeof context.abort, "function");
  assert.equal(typeof context.isIdle, "function");
});
