import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href,
);
const loaderMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "loader.js"))
    .href,
);
const promptContextMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "prompt-context.js"),
  ).href,
);

test("scheduled chat-bound turns inject chat guidance without fake sender fields", async () => {
  const cwd = rootDir;
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-scheduled-chat-prompt-"),
  );
  const codingAgentModule = await loaderMod.loadRinCodingAgent();
  const { SessionManager } = codingAgentModule;
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
    sessionManager,
  });
  const baseSystemPrompt = String(
    runtimeMod.ensureSessionBaseSystemPrompt(session),
  );

  promptContextMod.enqueueChatPromptContext({
    source: "chat-bridge",
    chatKey: "telegram/demo:1",
    triggerKind: "scheduled-task",
  });

  const inputResult = await session._extensionRunner?.emitInput(
    "scheduled hello",
    undefined,
    "chat-bridge",
  );
  const prompt =
    inputResult?.action === "transform" ? inputResult.text : "scheduled hello";
  const beforeStart = await session._extensionRunner?.emitBeforeAgentStart(
    prompt,
    undefined,
    baseSystemPrompt,
  );
  const finalSystemPrompt = String(
    beforeStart?.systemPrompt || baseSystemPrompt,
  );
  const header = String(beforeStart?.messages?.[0]?.content || "");

  assert.ok(finalSystemPrompt.includes("Chat bridge guidelines:"));
  assert.ok(finalSystemPrompt.includes("- chatKey: telegram/demo:1"));
  assert.ok(
    finalSystemPrompt.includes(
      "The target chat platform may not render Markdown reliably.",
    ),
  );
  assert.equal(
    finalSystemPrompt.includes(
      "Each message in this conversation comes from a user on the chat platform.",
    ),
    false,
  );
  assert.equal(
    finalSystemPrompt.includes("Use `save_chat_user_identity`"),
    false,
  );
  assert.ok(header.includes("chat trigger: scheduled task"));
  assert.equal(header.includes("sender user id:"), false);
  assert.equal(header.includes("sender nickname:"), false);
});
