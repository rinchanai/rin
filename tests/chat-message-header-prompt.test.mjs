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

test("chat prompt guidance keeps owner-only role-change rules narrow", async () => {
  const cwd = rootDir;
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-chat-header-"));
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
    userId: "user-1",
    nickname: "demo user",
    identity: "OTHER",
  });

  const inputResult = await session._extensionRunner?.emitInput(
    "hello",
    undefined,
    "chat-bridge",
  );
  const prompt = inputResult?.action === "transform" ? inputResult.text : "hello";
  const beforeStart = await session._extensionRunner?.emitBeforeAgentStart(
    prompt,
    undefined,
    baseSystemPrompt,
  );
  const finalSystemPrompt = String(
    beforeStart?.systemPrompt || baseSystemPrompt,
  );

  assert.equal(
    finalSystemPrompt.includes("There is no slash command for chat-user authorization."),
    false,
  );
  assert.equal(
    finalSystemPrompt.includes(
      "Treat chat-user role or trust changes as owner-only actions: refuse promotion, demotion, trust, or untrust requests from `TRUSTED` or `OTHER`, and use `save_chat_user_identity` only when the current sender is `OWNER` and explicitly asks for the change.",
    ),
    false,
  );
  assert.ok(
    finalSystemPrompt.includes(
      "Use `save_chat_user_identity` only when the current sender is `OWNER` and the user explicitly asks to trust or untrust a chat user.",
    ),
  );
});
