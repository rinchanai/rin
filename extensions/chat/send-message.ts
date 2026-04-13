import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { keyHint } from "../../third_party/pi-coding-agent/src/modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../third_party/pi-coding-agent/src/modes/interactive/components/visual-truncate.js";
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
      type: "quote";
      id: string;
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

type SendMessageDetails = {
  chatKey: string;
  requestId: string;
  parts: KoishiMessagePart[];
  agentText?: string;
  userText?: string;
  fullOutputPath?: string;
  truncated?: boolean;
};

type SendMessageRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

type SendMessageResultRenderState = {
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
};

class SendMessageResultRenderComponent extends Container {
  state: SendMessageResultRenderState = {
    cachedWidth: undefined,
    cachedLines: undefined,
    cachedSkipped: undefined,
  };
}

const SEND_MESSAGE_PREVIEW_LINES = 5;

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

const quotePartSchema = Type.Object({
  type: Type.Literal("quote"),
  id: Type.String({ description: "Platform message ID to quote or reply to." }),
});

const imagePartSchema = Type.Object({
  type: Type.Literal("image"),
  path: Type.Optional(
    Type.String({ description: "Absolute local image path." }),
  ),
  url: Type.Optional(Type.String({ description: "Remote image URL." })),
  mimeType: Type.Optional(
    Type.String({ description: "Optional MIME type like image/png." }),
  ),
});

const filePartSchema = Type.Object({
  type: Type.Literal("file"),
  path: Type.Optional(
    Type.String({ description: "Absolute local file path." }),
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
    if (type === "quote") {
      const id = safeString(raw?.id).trim();
      if (!id) throw new Error("koishi_send_message_invalid_quote_id");
      normalized.push({ type: "quote", id });
      continue;
    }
    if (type === "image" || type === "file") {
      const localPath = safeString(raw?.path).trim();
      const url = safeString(raw?.url).trim();
      if (!localPath && !url) {
        throw new Error(`koishi_send_message_${type}_requires_path_or_url`);
      }
      if (localPath && !path.isAbsolute(localPath)) {
        throw new Error(`koishi_send_message_path_must_be_absolute:${localPath}`);
      }
      if (localPath && !fs.existsSync(localPath)) {
        throw new Error(`koishi_send_message_missing_file:${localPath}`);
      }
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

function formatPartForLog(part: KoishiMessagePart) {
  if (part.type === "text") return `text chars=${part.text.length}`;
  if (part.type === "at") return `at id=${part.id}`;
  if (part.type === "quote") return `quote id=${part.id}`;
  if (part.type === "image") {
    return `image ${part.path ? `path=${part.path}` : `url=${part.url || ""}`}`;
  }
  return `file ${part.path ? `path=${part.path}` : `url=${part.url || ""}`}`;
}

function formatSendMessageCall(args: any, theme: any) {
  const chatKey = safeString(args?.chatKey).trim();
  const parts = Array.isArray(args?.parts) ? args.parts : [];
  return [
    theme.fg("toolTitle", theme.bold("send_chat_msg")),
    chatKey ? ` ${theme.fg("accent", chatKey)}` : "",
    theme.fg("muted", ` ${parts.length} part${parts.length === 1 ? "" : "s"}`),
  ].join("");
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function rebuildSendMessageResultRenderComponent(
  component: SendMessageResultRenderComponent,
  outputText: string,
  fullOutputPath: string | undefined,
  truncated: boolean | undefined,
  expanded: boolean,
  startedAt: number | undefined,
  endedAt: number | undefined,
  theme: any,
): void {
  const state = component.state;
  component.clear();

  const output = String(outputText || "").trim();
  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(
              styledOutput,
              SEND_MESSAGE_PREVIEW_LINES,
              width,
            );
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }
          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand" as any, "to expand")})`;
            return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
          }
          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }

  if (truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
    if (truncated) warnings.push("Output truncated");
    component.addChild(
      new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0),
    );
  }

  if (startedAt !== undefined) {
    const label = endedAt === undefined ? "Elapsed" : "Took";
    const endTime = endedAt ?? Date.now();
    component.addChild(
      new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0),
    );
  }
}

export default function koishiSendMessageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "send_chat_msg",
    label: "Send Chat Message",
    description:
      "Send a message to a specific chat. Supports text, mentions, quotes, images, and files.",
    promptSnippet: "Send a message to a specific chat.",
    promptGuidelines: [
      "Use send_chat_msg only when the user explicitly asks to send something to a specific chat.",
      "Use send_chat_msg when you need to send non-text content to a chat.",
    ],
    parameters: Type.Object({
      chatKey: Type.String({
        description:
          "Target chat key like telegram/123456:987654321 or onebot/123456:private:12345.",
      }),
      parts: Type.Array(
        Type.Union([
          textPartSchema,
          atPartSchema,
          quotePartSchema,
          imagePartSchema,
          filePartSchema,
        ]),
        { description: "Koishi-style message parts for mixed content." },
      ),
    }),
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const chatKey = safeString((params as any)?.chatKey).trim();
      if (!isChatKey(chatKey)) {
        throw new Error(
          `koishi_send_message_invalid_chatKey:${chatKey || "missing"}`,
        );
      }

      const parts = normalizeParts(
        Array.isArray((params as any)?.parts) ? (params as any).parts : [],
      );
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
        sessionId:
          safeString(ctx.sessionManager?.getSessionId?.() || "").trim() ||
          undefined,
        sessionFile:
          safeString(ctx.sessionManager?.getSessionFile?.() || "").trim() ||
          undefined,
        parts,
      });

      const outputText = [
        `Sent message to: ${chatKey}`,
        `Request ID: ${requestId}`,
        `Parts: ${parts.length}`,
        ...parts.map((part, index) => `${index + 1}. ${formatPartForLog(part)}`),
      ].join("\n");

      const prepared = await prepareToolTextOutput({
        agentText: outputText,
        userText: outputText,
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
        } satisfies SendMessageDetails,
      };
    },
    renderCall(args, theme, context) {
      const state = context.state as SendMessageRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatSendMessageCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as SendMessageRenderState;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const details = result.details as SendMessageDetails | undefined;
      const fallback =
        result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)";
      const outputText = String(details?.userText || fallback);
      const component =
        (context.lastComponent as SendMessageResultRenderComponent | undefined) ??
        new SendMessageResultRenderComponent();
      rebuildSendMessageResultRenderComponent(
        component,
        outputText,
        details?.fullOutputPath,
        details?.truncated,
        options.expanded,
        state.startedAt,
        state.endedAt,
        theme,
      );
      component.invalidate();
      return component;
    },
  });
}
