import { safeString } from "../platform/process.js";

import { openBoundSession } from "./factory.js";
import { runAssistantTurnWithFinalText } from "./assistant-turn.js";

export async function runSessionPrompt(options: {
  cwd: string;
  agentDir: string;
  prompt: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
}) {
  const { session, runtime } = await openBoundSession(options);
  try {
    const { finalText } = await runAssistantTurnWithFinalText({
      session,
      start: async () => {
        await session.prompt(options.prompt, {
          expandPromptTemplates: false,
          source: "rpc" as any,
        });
      },
      waitForCompletion: async () => {
        await session.agent.waitForIdle();
      },
    });
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
      finalText,
    };
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}
