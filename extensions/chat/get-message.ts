import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { prepareToolTextOutput } from "../shared/tool-text.js";

async function loadMessageStoreModule() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = [
    path.join(root, "core", "rin-koishi", "message-store.js"),
    path.join(root, "dist", "core", "rin-koishi", "message-store.js"),
  ];
  const distPath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!distPath) {
    throw new Error(
      `rin_koishi_message_store_not_found:${candidates.join(" | ")}`,
    );
  }
  return await import(pathToFileURL(distPath).href);
}

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

export default function koishiGetMessageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_chat_msg",
    label: "Get Chat Message",
    description: "Get a specific chat message.",
    promptSnippet: "Get a specific chat message.",
    promptGuidelines: [
      "Use get_chat_msg to get the content of a specific chat message.",
    ],
    parameters: Type.Object({
      messageId: Type.String({
        description: "Platform message ID to look up.",
      }),
      chatKey: Type.Optional(
        Type.String({
          description:
            "Optional chat key to disambiguate duplicated platform message IDs.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const messageId = safeString((params as any)?.messageId).trim();
      const chatKey = safeString((params as any)?.chatKey).trim() || undefined;
      if (!messageId) throw new Error("koishi_get_message_messageId_required");

      const agentDir = getAgentDir();
      const {
        normalizeKoishiMessageLookup,
        describeKoishiMessageRecord,
        summarizeKoishiMessageRecord,
      } = await loadMessageStoreModule();
      const matches = normalizeKoishiMessageLookup(
        agentDir,
        messageId,
        chatKey,
      );
      const agentText = matches.length
        ? [
            "get_chat_msg",
            ...matches.map(
              (item: any, index: number) =>
                `match ${index + 1}\n${describeKoishiMessageRecord(item)}`,
            ),
          ].join("\n\n")
        : `get_chat_msg\nnot_found messageId=${messageId}${chatKey ? `\nchatKey=${chatKey}` : ""}`;
      const prepared = await prepareToolTextOutput({
        agentText,
        userText: matches.length
          ? [
              "找到这些消息：",
              ...matches.map(
                (item: any, index: number) =>
                  `${index + 1}.\n${summarizeKoishiMessageRecord(item)}`,
              ),
            ].join("\n\n")
          : `未找到消息：${messageId}${chatKey ? `（chatKey=${chatKey}）` : ""}`,
        tempPrefix: "rin-koishi-message-",
        filename: "koishi-message.txt",
      });

      return {
        content: [{ type: "text", text: prepared.agentText }],
        details: { messageId, chatKey, matches, ...prepared },
        isError: !matches.length,
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
