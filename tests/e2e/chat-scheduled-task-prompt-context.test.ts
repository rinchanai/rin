import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const promptContextMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "prompt-context.js"),
  ).href
);

test("scheduled chat-bound prompt context omits fake sender fields", () => {
  const promptText = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      chatKey: "telegram/demo:1",
      triggerKind: "scheduled-task",
    },
    "scheduled hello",
  );

  assert.ok(promptText.includes("chatKey: telegram/demo:1"));
  assert.ok(promptText.includes("chat trigger: scheduled task"));
  assert.ok(
    promptText.includes(
      "runtime note: header lines above `---` are runtime metadata for this message, not user-authored text.",
    ),
  );
  assert.equal(promptText.includes("sender user id:"), false);
  assert.equal(promptText.includes("sender nickname:"), false);
  assert.ok(promptText.endsWith("---\nscheduled hello"));
});
