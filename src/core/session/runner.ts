import { safeString } from "../platform/process.js";

import { openBoundSession } from "./factory.js";
import { extractAssistantFinalText } from "./assistant-text.js";

export async function runSessionPrompt(options: {
  cwd: string;
  agentDir: string;
  prompt: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
}) {
  const { session, runtime } = await openBoundSession(options);
  let latestAssistantText = "";
  const rawUnsubscribe = session.subscribe?.((event: any) => {
    if (event?.type !== "message_end") return;
    if (event?.message?.role !== "assistant") return;
    const text = extractAssistantFinalText(event.message.content);
    if (text) latestAssistantText = text;
  });
  const unsubscribe = typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;
  try {
    latestAssistantText = "";
    await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "rpc" as any,
    });
    await session.agent.waitForIdle();
    if (!latestAssistantText) throw new Error("final_assistant_text_missing");
    const sessionFile =
      safeString(
        session.sessionFile || session.sessionManager?.getSessionFile?.() || "",
      ).trim() || undefined;
    const sessionId =
      safeString(session.sessionId || session.sessionManager?.getSessionId?.() || "").trim() ||
      undefined;
    return {
      session,
      sessionFile,
      sessionId,
      finalText: latestAssistantText,
    };
  } finally {
    try {
      unsubscribe?.();
    } catch {}
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}
