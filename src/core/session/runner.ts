import { safeString } from "../platform/process.js";

import { openBoundSession } from "./factory.js";
import { buildTurnResultFromMessages } from "./turn-result.js";

export async function runSessionPrompt(options: {
  cwd: string;
  agentDir: string;
  prompt: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
}) {
  const { session, runtime } = await openBoundSession(options);
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
    const turnResult = buildTurnResultFromMessages(session.messages || []);
    const finalTextFromResult = turnResult.messages
      .filter((item) => item?.type === "text")
      .map((item) => safeString((item as any).text || "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const finalText =
      finalTextFromResult ||
      safeString(session.getLastAssistantText?.() || "").trim();
    return { session, sessionFile, sessionId, finalText, turnResult };
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}
