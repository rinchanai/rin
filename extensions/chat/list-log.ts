import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { prepareToolTextOutput } from "../shared/tool-text.js";

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

export default function koishiListChatLogExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_chat_log",
    label: "List Chat Log",
    description: "List chat records for a specific chatKey on a specific date.",
    promptSnippet:
      "List chat records for a specific chatKey on a specific date.",
    promptGuidelines: [
      "Use list_chat_log to list chat records for a specific chatKey on a specific date.",
    ],
    parameters: Type.Object({
      chatKey: Type.String({
        description:
          "Target chat key like telegram/123456:987654321 or onebot:private:12345.",
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
      const body = formatKoishiChatLog(entries);
      const agentText = entries.length
        ? [
            `list_chat_log`,
            `chatKey=${chatKey}`,
            `date=${date}`,
            `path=${filePath}`,
            `count=${entries.length}`,
            "",
            body,
          ].join("\n")
        : [
            `list_chat_log`,
            `chatKey=${chatKey}`,
            `date=${date}`,
            `path=${filePath}`,
            `count=0`,
            `status=empty`,
          ].join("\n");
      const userText = entries.length
        ? [
            `Chat log: ${chatKey}`,
            `Date: ${date}`,
            `Path: ${filePath}`,
            "",
            body,
          ].join("\n")
        : `No chat log found\nchatKey=${chatKey}\ndate=${date}\npath=${filePath}`;
      const prepared = await prepareToolTextOutput({
        agentText,
        userText,
        tempPrefix: "rin-chat-log-",
        filename: "chat-log.txt",
      });
      return {
        content: [{ type: "text", text: prepared.agentText }],
        details: {
          chatKey,
          date,
          filePath,
          count: entries.length,
          entries,
          ...prepared,
        },
        isError: false,
      };
    },
    renderResult(result) {
      const details = result.details as any;
      const fallback =
        result.content?.[0]?.type === "text"
          ? result.content[0].text
          : "(no output)";
      return new Text(String(details?.userText || fallback), 0, 0);
    },
  });
}
