import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  appendTokenTelemetryEvent,
  resolveAgentDir,
} from "./store.js";
import { extractToolCallNames } from "../message-content.js";
import { readSessionMetadata } from "../session/metadata.js";
import { safeString } from "../text-utils.js";

type SessionState = {
  seq: number;
  source: string;
  turnIndex: number | null;
  lastPromptPreview: string;
  lastInputPreview: string;
  trigger: string;
  provider: string;
  model: string;
  thinkingLevel: string;
};

const sessionStateById = new Map<string, SessionState>();
const extensionInstanceId = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

function previewText(value: unknown, limit = 220): string {
  const text = safeString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

function previewJson(value: unknown, limit = 260): string {
  try {
    return previewText(JSON.stringify(value || {}), limit);
  } catch {
    return previewText("[unserializable]", limit);
  }
}

const sessionMeta = readSessionMetadata;

function sessionKey(ctx: any) {
  const meta = sessionMeta(ctx);
  return meta.sessionId || meta.sessionFile || meta.cwd || "default";
}

function getSessionState(ctx: any): SessionState {
  const key = sessionKey(ctx);
  let state = sessionStateById.get(key);
  if (!state) {
    state = {
      seq: 0,
      source: "",
      turnIndex: null,
      lastPromptPreview: "",
      lastInputPreview: "",
      trigger: "",
      provider: "",
      model: "",
      thinkingLevel: "",
    };
    sessionStateById.set(key, state);
  }
  if (!state.thinkingLevel && ctx?.getThinkingLevel) {
    try {
      state.thinkingLevel = safeString(ctx.getThinkingLevel()).trim();
    } catch {}
  }
  return state;
}

function nextEventId(prefix: string, ctx: any) {
  const meta = sessionMeta(ctx);
  const state = getSessionState(ctx);
  state.seq += 1;
  return [
    meta.sessionId || meta.sessionFile || "session",
    extensionInstanceId,
    prefix,
    String(state.seq),
  ].join(":");
}

function inferCapability(eventType: string, message: any, toolName = "") {
  const normalizedToolName = safeString(toolName).trim();
  if (eventType === "tool_execution_start" || eventType === "tool_execution_end") {
    return {
      capabilityKind: "tool_execution",
      capabilityKey: normalizedToolName ? `tool:${normalizedToolName}` : "tool:(unknown)",
    };
  }

  if (message?.role === "assistant") {
    const toolCalls = extractToolCallNames(message?.content);
    if (!toolCalls.length) {
      return {
        capabilityKind: "assistant_text",
        capabilityKey: "assistant:text",
      };
    }
    if (toolCalls.length === 1) {
      return {
        capabilityKind: "assistant_tool_call",
        capabilityKey: `tool:${toolCalls[0]}`,
      };
    }
    return {
      capabilityKind: "assistant_multi_tool_call",
      capabilityKey: `tools:${toolCalls.sort().join("+")}`,
    };
  }

  if (message?.role === "toolResult") {
    return {
      capabilityKind: "tool_result",
      capabilityKey: normalizedToolName ? `tool:${normalizedToolName}` : "tool_result",
    };
  }

  if (message?.role === "user") {
    return {
      capabilityKind: "user_input",
      capabilityKey: "user:input",
    };
  }

  return {
    capabilityKind: eventType.startsWith("session_") ? "session" : "runtime",
    capabilityKey: `${eventType || "event"}`,
  };
}

function recordEvent(ctx: any, input: Record<string, any>) {
  const meta = sessionMeta(ctx);
  const state = getSessionState(ctx);
  appendTokenTelemetryEvent(
    {
      id: safeString(input.id).trim() || nextEventId(safeString(input.eventType).trim() || "event", ctx),
      timestamp: safeString(input.timestamp).trim() || new Date().toISOString(),
      sessionId: meta.sessionId,
      sessionFile: meta.sessionFile,
      sessionName: meta.sessionName,
      sessionPersisted: meta.sessionPersisted,
      cwd: meta.cwd,
      eventType: safeString(input.eventType).trim() || "event",
      source: safeString(input.source).trim() || state.source,
      trigger: safeString(input.trigger).trim() || state.trigger,
      turnIndex: input.turnIndex ?? state.turnIndex,
      phase: safeString(input.phase).trim(),
      provider: safeString(input.provider).trim() || state.provider,
      model: safeString(input.model).trim() || state.model,
      thinkingLevel: safeString(input.thinkingLevel).trim() || state.thinkingLevel,
      messageId: safeString(input.messageId).trim(),
      messageRole: safeString(input.messageRole).trim(),
      stopReason: safeString(input.stopReason).trim(),
      toolCallId: safeString(input.toolCallId).trim(),
      toolName: safeString(input.toolName).trim(),
      toolCallCount: Number(input.toolCallCount || 0) || 0,
      toolNames: Array.isArray(input.toolNames) ? input.toolNames : [],
      capabilityKind: safeString(input.capabilityKind).trim(),
      capabilityKey: safeString(input.capabilityKey).trim(),
      inputTokens: Number(input.inputTokens || 0) || 0,
      outputTokens: Number(input.outputTokens || 0) || 0,
      cacheReadTokens: Number(input.cacheReadTokens || 0) || 0,
      cacheWriteTokens: Number(input.cacheWriteTokens || 0) || 0,
      totalTokens: Number(input.totalTokens || 0) || 0,
      costInput: Number(input.costInput || 0) || 0,
      costOutput: Number(input.costOutput || 0) || 0,
      costCacheRead: Number(input.costCacheRead || 0) || 0,
      costCacheWrite: Number(input.costCacheWrite || 0) || 0,
      costTotal: Number(input.costTotal || 0) || 0,
      contextTokens: Number(input.contextTokens || 0) || 0,
      isError: Boolean(input.isError),
      metadata: (input.metadata as any) || null,
    },
    resolveAgentDir(),
  );
}

export default function tokenUsageExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    const state = getSessionState(ctx);
    state.trigger = safeString(event?.reason).trim();
    if (!state.thinkingLevel) {
      try {
        state.thinkingLevel = safeString(pi.getThinkingLevel()).trim();
      } catch {}
    }
    recordEvent(ctx, {
      eventType: "session_start",
      trigger: state.trigger,
      metadata: {
        reason: safeString(event?.reason).trim(),
        previousSessionFile: safeString(event?.previousSessionFile).trim(),
      },
    });
  });

  pi.on("input", async (event, ctx) => {
    const state = getSessionState(ctx);
    state.source = safeString(event?.source).trim();
    state.lastInputPreview = previewText(event?.text);
    recordEvent(ctx, {
      eventType: "input",
      source: state.source,
      capabilityKind: "user_input",
      capabilityKey: "user:input",
      metadata: {
        textPreview: state.lastInputPreview,
        imageCount: Array.isArray(event?.images) ? event.images.length : 0,
      },
    });
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getSessionState(ctx);
    state.lastPromptPreview = previewText(event?.prompt);
    try {
      state.thinkingLevel = safeString(pi.getThinkingLevel()).trim() || state.thinkingLevel;
    } catch {}
    recordEvent(ctx, {
      eventType: "before_agent_start",
      phase: "agent",
      metadata: {
        promptPreview: state.lastPromptPreview,
        systemPromptChars: safeString(event?.systemPrompt).length,
      },
    });
  });

  pi.on("model_select", async (event, ctx) => {
    const state = getSessionState(ctx);
    state.provider = safeString(event?.model?.provider).trim();
    state.model = safeString(event?.model?.id || event?.model?.name).trim();
    recordEvent(ctx, {
      eventType: "model_select",
      provider: state.provider,
      model: state.model,
      metadata: {
        source: safeString(event?.source).trim(),
        previousProvider: safeString(event?.previousModel?.provider).trim(),
        previousModel: safeString(event?.previousModel?.id || event?.previousModel?.name).trim(),
      },
    });
  });

  pi.on("turn_start", async (event, ctx) => {
    const state = getSessionState(ctx);
    state.turnIndex = Number(event?.turnIndex);
    recordEvent(ctx, {
      eventType: "turn_start",
      turnIndex: state.turnIndex,
      phase: "turn",
      metadata: {
        timestamp: Number(event?.timestamp || 0) || 0,
      },
    });
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const capability = inferCapability("tool_execution_start", null, event?.toolName);
    recordEvent(ctx, {
      id: [sessionKey(ctx), "tool_execution_start", safeString(event?.toolCallId).trim() || nextEventId("tool", ctx)].join(":"),
      eventType: "tool_execution_start",
      phase: "tool",
      toolCallId: safeString(event?.toolCallId).trim(),
      toolName: safeString(event?.toolName).trim(),
      capabilityKind: capability.capabilityKind,
      capabilityKey: capability.capabilityKey,
      metadata: {
        argsPreview: previewJson(event?.args || {}, 260),
      },
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const capability = inferCapability("tool_execution_end", null, event?.toolName);
    recordEvent(ctx, {
      id: [sessionKey(ctx), "tool_execution_end", safeString(event?.toolCallId).trim() || nextEventId("tool", ctx)].join(":"),
      eventType: "tool_execution_end",
      phase: "tool",
      toolCallId: safeString(event?.toolCallId).trim(),
      toolName: safeString(event?.toolName).trim(),
      capabilityKind: capability.capabilityKind,
      capabilityKey: capability.capabilityKey,
      isError: Boolean(event?.isError),
      metadata: {
        resultPreview: previewJson(event?.result || {}, 260),
      },
    });
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event?.message as any;
    const toolNames = extractToolCallNames(message?.content);
    const capability = inferCapability("message_end", message, message?.toolName);
    const usage = message?.usage || {};
    const totalTokens =
      Number(usage?.totalTokens || 0) ||
      Number(usage?.input || 0) +
        Number(usage?.output || 0) +
        Number(usage?.cacheRead || 0) +
        Number(usage?.cacheWrite || 0);
    recordEvent(ctx, {
      id:
        safeString(message?.id).trim()
          ? [sessionKey(ctx), "message_end", safeString(message?.id).trim()].join(":")
          : nextEventId("message_end", ctx),
      eventType: "message_end",
      phase: "message",
      provider: safeString(message?.provider).trim(),
      model: safeString(message?.model).trim(),
      messageId: safeString(message?.id).trim(),
      messageRole: safeString(message?.role).trim(),
      stopReason: safeString(message?.stopReason).trim(),
      toolCallId: safeString(message?.toolCallId).trim(),
      toolName: safeString(message?.toolName).trim(),
      toolCallCount: toolNames.length,
      toolNames,
      capabilityKind: capability.capabilityKind,
      capabilityKey: capability.capabilityKey,
      inputTokens: Number(usage?.input || 0) || 0,
      outputTokens: Number(usage?.output || 0) || 0,
      cacheReadTokens: Number(usage?.cacheRead || 0) || 0,
      cacheWriteTokens: Number(usage?.cacheWrite || 0) || 0,
      totalTokens,
      costInput: Number(usage?.cost?.input || 0) || 0,
      costOutput: Number(usage?.cost?.output || 0) || 0,
      costCacheRead: Number(usage?.cost?.cacheRead || 0) || 0,
      costCacheWrite: Number(usage?.cost?.cacheWrite || 0) || 0,
      costTotal: Number(usage?.cost?.total || 0) || 0,
      contextTokens: Number(usage?.totalTokens || 0) || 0,
      isError:
        safeString(message?.stopReason).trim() === "error" ||
        safeString(message?.errorMessage).trim().length > 0,
      metadata: {
        inputPreview: getSessionState(ctx).lastInputPreview,
        promptPreview: getSessionState(ctx).lastPromptPreview,
        errorMessage: previewText(message?.errorMessage, 260),
      },
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    recordEvent(ctx, {
      eventType: "agent_end",
      phase: "agent",
      metadata: {
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
      },
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    recordEvent(ctx, {
      eventType: "session_compact",
      metadata: {
        fromExtension: Boolean(event?.fromExtension),
        compactionEntryId: safeString(event?.compactionEntry?.id).trim(),
      },
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    recordEvent(ctx, {
      eventType: "session_shutdown",
    });
    sessionStateById.delete(sessionKey(ctx));
  });
}
