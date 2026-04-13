import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { keyHint } from "../../third_party/pi-coding-agent/src/modes/interactive/components/keybinding-hints.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "../../third_party/pi-coding-agent/src/core/tools/truncate.js";
import {
  getTextOutput,
  replaceTabs,
} from "../../third_party/pi-coding-agent/src/core/tools/render-utils.js";

async function loadChatLogModule() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = [
    path.join(root, "core", "rin-koishi", "chat-log.js"),
    path.join(root, "dist", "core", "rin-koishi", "chat-log.js"),
  ];
  const distPath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!distPath) {
    throw new Error(`rin_koishi_chat_log_not_found:${candidates.join(" | ")}`);
  }
  return await import(pathToFileURL(distPath).href);
}

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
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

function formatListChatLogCall(args: any, theme: any) {
  const chatKey = safeString(args?.chatKey).trim();
  const date = safeString(args?.date).trim();
  return [
    theme.fg("toolTitle", theme.bold("list_chat_log")),
    chatKey ? ` ${theme.fg("accent", chatKey)}` : "",
    date ? ` ${theme.fg("muted", date)}` : "",
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
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }

  return text;
}

export default function koishiListChatLogExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_chat_log",
    label: "List Chat Log",
    description: "List chat records for a specific chatKey on a specific date.",
    promptSnippet:
      "List chat records for a specific chatKey on a specific date.",
    promptGuidelines: [],
    parameters: Type.Object({
      chatKey: Type.String({
        description:
          "Target chat key like telegram/123456:987654321 or onebot/123456:private:12345.",
      }),
      date: Type.String({
        description: "Date to inspect in YYYY-MM-DD format.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const chatKey = safeString((params as any)?.chatKey).trim();
      const date = safeString((params as any)?.date).trim();
      if (!chatKey) throw new Error("koishi_list_chat_log_chatKey_required");
      if (!date) throw new Error("koishi_list_chat_log_date_required");

      const agentDir = getAgentDir();
      const { readKoishiChatLog, formatKoishiChatLog } =
        await loadChatLogModule();
      const { filePath, entries } = readKoishiChatLog(agentDir, chatKey, date);
      const text = entries.length
        ? [
            `chatKey=${chatKey}`,
            `date=${date}`,
            `path=${filePath}`,
            `count=${entries.length}`,
            "",
            formatKoishiChatLog(entries),
          ].join("\n")
        : `No chat log found\nchatKey=${chatKey}\ndate=${date}\npath=${filePath}`;
      const truncation = truncateHead(text);
      let outputText = truncation.content;
      if (truncation.truncated) {
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
        } else {
          outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
        }
      }
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
