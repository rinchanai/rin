
import {
  getAgentDir,
  type ExtensionAPI,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  prepareTruncatedText,
  renderTextToolResult,
} from "../pi/render-utils.js";
import { safeString } from "../text-utils.js";
import { formatLocalDateOnly } from "./date.js";

async function loadChatLogModule() {
  return await import("./chat-log.js");
}

type ListChatLogDetails = {
  chatKey: string;
  date: string;
  filePath: string;
  count: number;
  entries: any[];
  truncation?: TruncationResult;
};

function formatListChatLogCall(args: any, theme: any) {
  const chatKey = safeString(args?.chatKey).trim();
  const date = safeString(args?.date).trim();
  return [
    theme.fg("toolTitle", theme.bold("list_chat_log")),
    chatKey ? ` ${theme.fg("accent", chatKey)}` : "",
    theme.fg("muted", ` ${date || formatLocalDateOnly()}`),
  ].join("");
}

function formatListChatLogResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  return renderTextToolResult(result, options, theme, showImages, {
    truncation: result.details?.truncation as TruncationResult | undefined,
  });
}

export default function chatListChatLogExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_chat_log",
    label: "List Chat Log",
    description: "List chat records for a specific chat.",
    promptSnippet: "List chat records for a specific chat.",
    promptGuidelines: [],
    parameters: Type.Object({
      chatKey: Type.String({
        description:
          "Target chat like telegram/123456:987654321 or onebot/123456:private:12345.",
      }),
      date: Type.Optional(
        Type.String({
          description:
            "Optional date to inspect in YYYY-MM-DD format. Defaults to today.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const chatKey = safeString((params as any)?.chatKey).trim();
      const date =
        safeString((params as any)?.date).trim() || formatLocalDateOnly();
      if (!chatKey) throw new Error("chat_list_log_chatKey_required");

      const agentDir = getAgentDir();
      const { readChatLog, formatChatLog } = await loadChatLogModule();
      const { filePath, entries } = readChatLog(agentDir, chatKey, date);
      const text = entries.length
        ? [
            `chatKey=${chatKey}`,
            `date=${date}`,
            `path=${filePath}`,
            `count=${entries.length}`,
            "",
            formatChatLog(entries),
          ].join("\n")
        : `No chat log found\nchatKey=${chatKey}\ndate=${date}\npath=${filePath}`;
      const truncated = prepareTruncatedText(text);
      return {
        content: [{ type: "text", text: truncated.outputText }],
        details: {
          chatKey,
          date,
          filePath,
          count: entries.length,
          entries,
          truncation: truncated.truncation,
        } satisfies ListChatLogDetails,
        isError: false,
      };
    },
    renderCall(args, theme) {
      return new Text(formatListChatLogCall(args, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return new Text(
        formatListChatLogResult(result, options, theme, context.showImages),
        0,
        0,
      );
    },
  });
}
