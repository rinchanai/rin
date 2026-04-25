import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { BuiltinModuleHost, CompositeBuiltinRunner } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "builtins", "host.js")).href
);
const { attachBuiltinModulesToSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "builtins", "session.js"))
    .href
);
const builtinRegistry = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "builtins", "registry.js"))
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

test("composite builtin runner forwards extension context invalidation", () => {
  const calls: unknown[] = [];
  const builtinHost = new BuiltinModuleHost(
    "/tmp/rin-cwd",
    "/tmp/rin-agent",
    { name: "session-manager" },
    { name: "model-registry" },
  );
  const runner = new CompositeBuiltinRunner(
    {
      invalidate(message: string) {
        calls.push(message);
      },
    },
    builtinHost,
  );

  runner.invalidate("stale");

  assert.deepEqual(calls, ["stale"]);
});

test("composite builtin runner forwards optional diagnostics", () => {
  const builtinHost = new BuiltinModuleHost(
    "/tmp/rin-cwd",
    "/tmp/rin-agent",
    { name: "session-manager" },
    { name: "model-registry" },
  );
  const runner = new CompositeBuiltinRunner(
    {
      getCommandDiagnostics() {
        return [{ type: "warning", message: "command" }];
      },
      getShortcutDiagnostics() {
        return [{ type: "warning", message: "shortcut" }];
      },
    },
    builtinHost,
  );

  assert.deepEqual(runner.getCommandDiagnostics(), [
    { type: "warning", message: "command" },
  ]);
  assert.deepEqual(runner.getShortcutDiagnostics(), [
    { type: "warning", message: "shortcut" },
  ]);
});

test("composite builtin runner returns wrapped builtin tools for registry refresh", () => {
  const builtinHost = new BuiltinModuleHost(
    "/tmp/rin-cwd",
    "/tmp/rin-agent",
    { name: "session-manager" },
    { name: "model-registry" },
  );
  builtinHost.toolMap.set("search_memory", {
    definition: { name: "search_memory", description: "Search memory" },
    sourcePath: "/tmp/builtin/search-memory.ts",
  });
  const runner = new CompositeBuiltinRunner(undefined, builtinHost);

  const tools = runner.getAllRegisteredTools();

  assert.deepEqual(tools, [
    {
      definition: { name: "search_memory", description: "Search memory" },
      sourceInfo: {
        source: "builtin_module",
        path: "/tmp/builtin/search-memory.ts",
      },
    },
  ]);
});

test("headless builtin attachment emits session_start for runtime state restoration", async () => {
  const frozenPrompt = "frozen prompt from source session";
  const appendedEntries: unknown[] = [];
  const session = {
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "frozen-system-prompt",
          data: {
            version: 1,
            systemPrompt: frozenPrompt,
            updatedAt: "2026-04-25T00:00:00.000Z",
          },
        },
      ],
      appendCustomEntry: (customType: string, data: unknown) => {
        appendedEntries.push({ customType, data });
      },
    },
    modelRegistry: {},
    getActiveToolNames: () => [],
    getAllTools: () => [],
    setActiveToolsByName: () => {},
    _refreshToolRegistry: () => {},
  };
  const disabledNames = builtinRegistry.BUILTIN_MODULE_ORDER.filter(
    (name: string) => name !== "freeze-session-runtime",
  );

  await attachBuiltinModulesToSession(session, {
    cwd: "/tmp/rin-cwd",
    agentDir: "/tmp/rin-agent",
    disabledNames,
    reason: "startup",
  });

  const result = await session._extensionRunner.emitBeforeAgentStart(
    "prompt",
    undefined,
    "fresh rebuilt prompt",
  );

  assert.equal(result.systemPrompt, frozenPrompt);
  assert.deepEqual(appendedEntries, []);
});

test("headless builtin reload emits session_start for runtime state restoration", async () => {
  const frozenPrompt = "frozen prompt after reload";
  const appendedEntries: unknown[] = [];
  const session = {
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "frozen-system-prompt",
          data: {
            version: 1,
            systemPrompt: frozenPrompt,
            updatedAt: "2026-04-25T00:00:00.000Z",
          },
        },
      ],
      appendCustomEntry: (customType: string, data: unknown) => {
        appendedEntries.push({ customType, data });
      },
    },
    modelRegistry: {},
    getActiveToolNames: () => [],
    getAllTools: () => [],
    setActiveToolsByName: () => {},
    _refreshToolRegistry: () => {},
    reload: async () => {},
  };
  const disabledNames = builtinRegistry.BUILTIN_MODULE_ORDER.filter(
    (name: string) => name !== "freeze-session-runtime",
  );

  await attachBuiltinModulesToSession(session, {
    cwd: "/tmp/rin-cwd",
    agentDir: "/tmp/rin-agent",
    disabledNames,
    reason: "startup",
  });

  await session.reload();

  const result = await session._extensionRunner.emitBeforeAgentStart(
    "prompt",
    undefined,
    "fresh rebuilt prompt",
  );

  assert.equal(result.systemPrompt, frozenPrompt);
  assert.deepEqual(appendedEntries, []);
});

test("builtin registry normalizes disabled module names once", () => {
  assert.deepEqual(
    builtinRegistry.normalizeBuiltinModuleNames([
      " rules ",
      "RULES",
      " fetch ",
      "",
    ]),
    ["rules", "fetch"],
  );
});

test("builtin registry derives module order and paths from one table", () => {
  assert.deepEqual(
    builtinRegistry.getBuiltinModuleNames([" rules ", "FETCH"]),
    builtinRegistry.BUILTIN_MODULE_ORDER.filter(
      (name) => name !== "rules" && name !== "fetch",
    ),
  );
  assert.equal(
    builtinRegistry
      .getBuiltinModuleUrl("memory")
      .href.endsWith("/dist/core/memory/index.js"),
    true,
  );
});
