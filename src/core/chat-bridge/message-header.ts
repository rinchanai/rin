import type { BuiltinModuleApi } from "../builtins/host.js";

import {
  formatPromptContext,
  isPromptContextFormatted,
} from "./prompt-context.js";
import { safeString } from "../text-utils.js";

type RuntimeRole = "rpc-frontend" | "std-tui" | "agent-runtime";

const CHAT_REPLY_LOOKUP_SYSTEM_PROMPT =
  "Chat reply lookup rule: if the current message metadata contains `reply to message id: <id>`, always call `get_chat_msg` with that exact `<id>` before answering.";

function hasReplyMessageIdMetadata(text: string) {
  return /^reply to message id:\s*\S+/m.test(safeString(text));
}

function buildReplyLookupSystemPrompt(
  systemPrompt: unknown,
  promptText: string,
) {
  if (!hasReplyMessageIdMetadata(promptText)) return undefined;
  const current = safeString(systemPrompt).trimEnd();
  if (current.includes(CHAT_REPLY_LOOKUP_SYSTEM_PROMPT)) return undefined;
  return `${current}\n\n${CHAT_REPLY_LOOKUP_SYSTEM_PROMPT}`.trim();
}

function getRuntimeRole(): RuntimeRole {
  const argv = process.argv.slice(1);
  if (argv.includes("--rpc")) return "rpc-frontend";
  if (argv.includes("--std")) return "std-tui";
  return "agent-runtime";
}

export default function messageHeaderModule(pi: BuiltinModuleApi) {
  const pendingContexts: Array<{
    source: string;
    body: string;
    sentAt: number;
  }> = [];
  const runtimeRole = getRuntimeRole();

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };

    if (runtimeRole === "rpc-frontend") {
      return { action: "continue" };
    }

    pendingContexts.push({
      source: safeString(event.source).trim(),
      body: safeString(event.text),
      sentAt: Date.now(),
    });

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const current = pendingContexts.shift() || {
      source: "",
      body: safeString(event.prompt),
      sentAt: Date.now(),
    };
    const body = safeString(event.prompt || current.body);

    if (current.source === "chat-bridge" && isPromptContextFormatted(body)) {
      const systemPrompt = buildReplyLookupSystemPrompt(
        event.systemPrompt,
        body,
      );
      return systemPrompt ? { systemPrompt } : {};
    }

    return {
      message: {
        customType: "message-header-context",
        content: formatPromptContext(null, current.body, current.sentAt),
        display: false,
      },
    };
  });
}
