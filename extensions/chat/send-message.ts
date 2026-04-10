import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME_DIR = os.homedir();

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { prepareToolTextOutput } from "../shared/tool-text.js";

type KoishiMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "at";
      id: string;
      name?: string;
    }
  | {
      type: "image";
      path?: string;
      url?: string;
      mimeType?: string;
    }
  | {
      type: "file";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    };

async function loadKoishiRpcModule() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = [
    path.join(root, "core", "rin-koishi", "rpc.js"),
    path.join(root, "dist", "core", "rin-koishi", "rpc.js"),
  ];
  const distPath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!distPath) {
    throw new Error(`rin_koishi_rpc_not_found:${candidates.join(" | ")}`);
  }
  return await import(pathToFileURL(distPath).href);
}

const textPartSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String({ description: "Plain text to send." }),
});

const atPartSchema = Type.Object({
  type: Type.Literal("at"),
  id: Type.String({ description: "Platform user ID to mention." }),
  name: Type.Optional(
    Type.String({ description: "Optional display name hint." }),
  ),
});

const imagePartSchema = Type.Object({
  type: Type.Literal("image"),
  path: Type.Optional(
    Type.String({ description: "Absolute or relative local image path." }),
  ),
  url: Type.Optional(Type.String({ description: "Remote image URL." })),
  mimeType: Type.Optional(
    Type.String({ description: "Optional MIME type like image/png." }),
  ),
});

const filePartSchema = Type.Object({
  type: Type.Literal("file"),
  path: Type.Optional(
    Type.String({ description: "Absolute or relative local file path." }),
  ),
  url: Type.Optional(Type.String({ description: "Remote file URL." })),
  name: Type.Optional(
    Type.String({ description: "Optional file name override." }),
  ),
  mimeType: Type.Optional(Type.String({ description: "Optional MIME type." })),
});

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function resolveMaybeLocalPath(input: string, _cwd: string) {
  const value = input.trim();
  if (!value) return "";
  if (value === "~") return HOME_DIR;
  if (value.startsWith("~/")) return path.join(HOME_DIR, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(HOME_DIR, value);
}

function normalizeParts(parts: any[]): KoishiMessagePart[] {
  const normalized: KoishiMessagePart[] = [];
  for (const raw of parts) {
    const type = safeString(raw?.type).trim();
    if (type === "text") {
      const text = safeString(raw?.text);
      if (text) normalized.push({ type: "text", text });
      continue;
    }
    if (type === "at") {
      const id = safeString(raw?.id).trim();
      if (!id) throw new Error("koishi_send_message_invalid_at_id");
      normalized.push({
        type: "at",
        id,
        name: safeString(raw?.name).trim() || undefined,
      });
      continue;
    }
    if (type === "image" || type === "file") {
      const localPath = safeString(raw?.path).trim()
        ? resolveMaybeLocalPath(safeString(raw?.path), "")
        : "";
      const url = safeString(raw?.url).trim();
      if (!localPath && !url)
        throw new Error(`koishi_send_message_${type}_requires_path_or_url`);
      if (localPath && !fs.existsSync(localPath))
        throw new Error(`koishi_send_message_missing_file:${localPath}`);
      if (type === "image") {
        normalized.push({
          type: "image",
          path: localPath || undefined,
          url: url || undefined,
          mimeType: safeString(raw?.mimeType).trim() || undefined,
        });
      } else {
        normalized.push({
          type: "file",
          path: localPath || undefined,
          url: url || undefined,
          name: safeString(raw?.name).trim() || undefined,
          mimeType: safeString(raw?.mimeType).trim() || undefined,
        });
      }
      continue;
    }
    throw new Error(
      `koishi_send_message_unsupported_part:${type || "unknown"}`,
    );
  }
  return normalized;
}

function isChatKey(value: string) {
  return /^[^/:]+(?:\/[^:]+)?:.+$/.test(value.trim());
}

function formatPartForAgent(part: KoishiMessagePart) {
  if (part.type === "text") return `text chars=${part.text.length}`;
  if (part.type === "at") return `at id=${part.id}`;
  if (part.type === "image")
    return `image ${part.path ? `path=${part.path}` : `url=${part.url || ""}`}`;
  return `file ${part.path ? `path=${part.path}` : `url=${part.url || ""}`}`;
}

function formatPartForUser(part: KoishiMessagePart) {
  if (part.type === "text") return `- Text (${part.text.length} chars)`;
  if (part.type === "at") return `- @ ${part.name || part.id}`;
  if (part.type === "image") return `- Image: ${part.path || part.url || ""}`;
  return `- File: ${part.path || part.url || ""}${part.name ? ` (${part.name})` : ""}`;
}

export default function koishiSendMessageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "send_chat_msg",
    label: "Send Chat Message",
    description:
      "Send a message to a specific chatKey. Supports text, mentions, images, and files.",
    promptSnippet: "Send a message to a specific chat.",
    promptGuidelines: [
      "Use send_chat_msg to send content to a specific chat only when the user explicitly asks.",
    ],
    parameters: Type.Object({
      chatKey: Type.String({
        description:
          "Target chat key like telegram/123456:987654321 or onebot:private:12345.",
      }),
      text: Type.Optional(
        Type.String({
          description:
            "Convenience plain-text message. Prepended before parts.",
        }),
      ),
      parts: Type.Optional(
        Type.Array(
          Type.Union([
            textPartSchema,
            atPartSchema,
            imagePartSchema,
            filePartSchema,
          ]),
          { description: "Structured message parts for mixed content." },
        ),
      ),
      replyToMessageId: Type.Optional(
        Type.String({
          description: "Optional platform message ID to quote/reply to.",
        }),
      ),
    }),
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const chatKey = safeString((params as any)?.chatKey).trim();
      if (!isChatKey(chatKey))
        throw new Error(
          `koishi_send_message_invalid_chatKey:${chatKey || "missing"}`,
        );

      const parts = normalizeParts([
        ...(safeString((params as any)?.text)
          ? [{ type: "text", text: safeString((params as any).text) }]
          : []),
        ...(Array.isArray((params as any)?.parts)
          ? (params as any).parts
          : []),
      ]);

      if (!parts.length) throw new Error("koishi_send_message_empty");

      const agentDir = getAgentDir();
      const requestId =
        safeString(toolCallId).trim() || `koishi_${Date.now().toString(36)}`;
      const { deliverKoishiRpcPayload } = await loadKoishiRpcModule();
      await deliverKoishiRpcPayload(agentDir, {
        type: "parts_delivery",
        createdAt: new Date().toISOString(),
        requestId,
        chatKey,
        replyToMessageId:
          safeString((params as any)?.replyToMessageId).trim() || undefined,
        sessionId:
          safeString(ctx.sessionManager?.getSessionId?.() || "").trim() ||
          undefined,
        sessionFile:
          safeString(ctx.sessionManager?.getSessionFile?.() || "").trim() ||
          undefined,
        parts,
      });

      const agentText = [
        "send_chat_msg sent",
        `chatKey=${chatKey}`,
        `requestId=${requestId}`,
        ...parts.map(
          (part, index) => `${index + 1}. ${formatPartForAgent(part)}`,
        ),
      ].join("\n");

      const prepared = await prepareToolTextOutput({
        agentText,
        userText: [
          `Sent to chat: ${chatKey}`,
          `${parts.length} message part(s):`,
          ...parts.map((part) => formatPartForUser(part)),
          `Request ID: ${requestId}`,
        ].join("\n"),
        tempPrefix: "rin-koishi-send-",
        filename: "koishi-send.txt",
      });

      return {
        content: [{ type: "text", text: prepared.agentText }],
        details: {
          chatKey,
          requestId,
          parts,
          ...prepared,
        },
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
