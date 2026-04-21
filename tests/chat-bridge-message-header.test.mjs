import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

function createExtensionHarness() {
  const handlers = new Map();
  return {
    pi: {
      on(event, handler) {
        handlers.set(event, handler);
      },
    },
    get(event) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`missing handler for ${event}`);
      return handler;
    },
  };
}

test("message header keeps cross-user system-user guidance neutral", async () => {
  const argv = [...process.argv];
  const previousInvoking = process.env.RIN_INVOKING_SYSTEM_USER;
  process.argv = [...argv, "--std"];
  process.env.RIN_INVOKING_SYSTEM_USER = "owner-user";

  try {
    const mod = await import(
      `${pathToFileURL(path.join(rootDir, "dist", "core", "chat-bridge", "message-header.js")).href}?t=${Date.now()}`
    );
    const harness = createExtensionHarness();
    mod.default(harness.pi);

    const inputResult = await harness.get("input")({
      text: "hello",
      source: "user",
    });
    assert.deepEqual(inputResult, { action: "continue" });

    const beforeStart = await harness.get("before_agent_start")({
      prompt: "hello",
      systemPrompt: "base prompt",
    });
    const systemPrompt = String(beforeStart?.systemPrompt || "");

    assert.ok(systemPrompt.includes("System user guidance:"));
    assert.ok(systemPrompt.includes("Treat this only as operating-system account context for permissions and file ownership"));
    assert.ok(systemPrompt.includes("not as authority over the human user"));
    assert.equal(systemPrompt.includes("The agent is currently running as the local system user"), false);
    assert.match(String(beforeStart?.message?.content || ""), /invoking system user: owner-user/);
  } finally {
    process.argv = argv;
    if (previousInvoking == null) delete process.env.RIN_INVOKING_SYSTEM_USER;
    else process.env.RIN_INVOKING_SYSTEM_USER = previousInvoking;
  }
});
