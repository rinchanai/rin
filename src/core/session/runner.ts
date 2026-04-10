import { safeString } from "../platform/process.js";

import { openBoundSession } from "./factory.js";
import { createFinalAssistantTextCollector } from "./final-assistant-text.js";

export async function runSessionPrompt(options: {
  cwd: string;
  agentDir: string;
  prompt: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
}) {
  const { session, runtime } = await openBoundSession(options);
  const finalAssistantText = createFinalAssistantTextCollector();
  const unsubscribe = session.subscribe?.((event: any) => {
    finalAssistantText.observeEvent(event);
  });
  try {
    await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "rpc" as any,
    });
    await session.agent.waitForIdle();
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
      finalText: finalAssistantText.getText(),
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
