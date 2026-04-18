
import { getAgentDir, keyHint, truncateToVisualLines, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import {
  appendTruncationNotice,
  formatTruncationWarningMessage,
  getTextOutput,
  replaceTabs,
} from "../pi/render-utils.js";
import { safeString } from "../text-utils.js";

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

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function localDateString(date = new Date()) {
  const utc = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(utc).toISOString().slice(0, 10);
}

function formatListChatLogCall(args: any, theme: any) {
  const chatKey = safeString(args?.chatKey).trim();
  const date = safeString(args?.date).trim();
  return [
    theme.fg("toolTitle", theme.bold("list_chat_log")),
    chatKey ? ` ${theme.fg("accent", chatKey)}` : "",
    theme.fg("muted", ` ${date || localDateString()}`),
  ].join("");
}

function formatListChatLogResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let text = "";
  if (displayLines.length > 0) {
    text = `\n${displayLines
      .map((line) => theme.fg("toolOutput", replaceTabs(line)))
      .join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand" as any, "to expand")})`;
    }
  }

  const truncation = result.details?.truncation as TruncationResult | undefined;
  if (truncation?.truncated) {
    text += `\n${theme.fg("warning", `[${formatTruncationWarningMessage(truncation)}]`)}`;
  }

  return text;
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
        safeString((params as any)?.date).trim() || localDateString();
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
      const truncation = truncateHead(text);
      const outputText = appendTruncationNotice(
        truncation.content,
        truncation.truncated ? truncation : undefined,
      );
      return {
        content: [{ type: "text", text: outputText }],
        details: {
          chatKey,
          date,
          filePath,
          count: entries.length,
          entries,
          truncation: truncation.truncated ? truncation : undefined,
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
