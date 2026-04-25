import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { default: freezeSessionRuntimeModule } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "freeze-session-runtime.js"),
  ).href
);

function createHarness(branch: any[]) {
  const handlers = new Map<
    string,
    ((event: any, ctx: any) => Promise<any>)[]
  >();
  const appended: { customType: string; data: any }[] = [];
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
    },
  };
  const pi = {
    on: (
      eventName: string,
      handler: (event: any, ctx: any) => Promise<any>,
    ) => {
      const rows = handlers.get(eventName) || [];
      rows.push(handler);
      handlers.set(eventName, rows);
    },
    appendEntry: (customType: string, data: any) => {
      appended.push({ customType, data });
    },
  };

  freezeSessionRuntimeModule(pi);

  const emit = async (eventName: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(eventName) || []) {
      result = await handler(event, ctx);
    }
    return result;
  };

  return { appended, emit };
}

function frozenPrompt(systemPrompt: string) {
  return {
    type: "custom",
    customType: "frozen-system-prompt",
    data: {
      version: 1,
      systemPrompt,
      updatedAt: "2026-04-25T00:00:00.000Z",
    },
  };
}

test("frozen system prompts survive ordinary session shutdown", async () => {
  const { appended, emit } = createHarness([frozenPrompt("stable prompt")]);

  await emit("session_start", { reason: "startup" });
  await emit("session_shutdown", { reason: "quit" });
  const result = await emit("before_agent_start", {
    systemPrompt: "fresh rebuilt prompt",
  });

  assert.equal(result.systemPrompt, "stable prompt");
  assert.deepEqual(appended, []);
});

test("reload explicitly refreshes the frozen system prompt", async () => {
  const { appended, emit } = createHarness([frozenPrompt("old prompt")]);

  await emit("session_start", { reason: "reload" });
  const result = await emit("before_agent_start", {
    systemPrompt: "fresh rebuilt prompt",
  });

  assert.equal(result.systemPrompt, "fresh rebuilt prompt");
  assert.equal(appended.length, 1);
  assert.equal(appended[0].customType, "frozen-system-prompt");
  assert.equal(appended[0].data.systemPrompt, "fresh rebuilt prompt");
});

test("compaction entries invalidate earlier frozen system prompts", async () => {
  const { appended, emit } = createHarness([
    frozenPrompt("old prompt"),
    { type: "compaction" },
  ]);

  await emit("session_start", { reason: "startup" });
  const result = await emit("before_agent_start", {
    systemPrompt: "post compact prompt",
  });

  assert.equal(result.systemPrompt, "post compact prompt");
  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.systemPrompt, "post compact prompt");
});
