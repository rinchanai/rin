import type { AgentMessage as Message } from "@mariozechner/pi-agent-core";

import type { SubagentTask, TaskResult } from "./types.js";
import {
  isPersistedMode,
  normalizeSessionConfig,
} from "./session-management.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function syncSessionMetadata(session: any, result: TaskResult): void {
  const manager = session?.sessionManager;
  result.sessionPersisted = Boolean(
    manager?.isPersisted?.() && manager?.getSessionFile?.(),
  );
  result.sessionId =
    safeString(manager?.getSessionId?.() || "").trim() || undefined;
  result.sessionFile =
    safeString(manager?.getSessionFile?.() || "").trim() || undefined;
  result.sessionName =
    safeString(manager?.getSessionName?.() || "").trim() || undefined;
}

export function syncResultFromSession(session: any, result: TaskResult): void {
  const sessionMessages = Array.isArray(session?.messages)
    ? (session.messages as Message[])
    : Array.isArray(session?.agent?.state?.messages)
      ? (session.agent.state.messages as Message[])
      : [];

  result.messages.length = 0;
  result.messages.push(...sessionMessages);
  result.output = safeString(session?.getLastAssistantText?.() || "").trim();
  syncSessionMetadata(session, result);

  for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
    const message = sessionMessages[i] as any;
    if (message?.role !== "assistant") continue;
    result.stopReason = message.stopReason;
    result.errorMessage = message.errorMessage;
    if (message.model) {
      result.model = `${message.provider}/${message.model}`;
    }
    const usage = message.usage;
    result.usage = {
      input: usage?.input || 0,
      output: usage?.output || 0,
      cacheRead: usage?.cacheRead || 0,
      cacheWrite: usage?.cacheWrite || 0,
      cost: usage?.cost?.total || 0,
      contextTokens: usage?.totalTokens || 0,
      turns: usage ? 1 : 0,
    };
    break;
  }
}

export function makePendingResult(
  task: SubagentTask,
  index: number,
): TaskResult {
  const sessionConfig = normalizeSessionConfig(task.session);
  return {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    status: "pending",
    exitCode: 0,
    output: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    messages: [] as Message[],
    sessionMode: sessionConfig.mode,
    sessionPersisted: isPersistedMode(sessionConfig.mode),
  };
}
