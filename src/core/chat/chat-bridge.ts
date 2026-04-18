import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { keyHint, truncateToVisualLines, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateTail,
} from "@mariozechner/pi-coding-agent";
import { getTextOutput } from "../pi/render-utils.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { safeString } from "../text-utils.js";

const CHAT_BRIDGE_PREVIEW_LINES = 5;
const CHAT_BRIDGE_DOC_PATH = "~/.rin/docs/rin/docs/chat-bridge.md";

function parseChatKey(value: unknown) {
  const text = safeString(value).trim();
  return /^[^/:]+(?:\/[^:]+)?:.+$/.test(text) ? text : undefined;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return path.join(tmpdir(), `pi-chat-bridge-${id}.log`);
}

type ChatBridgeDetails = {
  truncation?: TruncationResult;
  fullOutputPath?: string;
  currentChatKey?: string;
  requestId?: string;
  auditPath?: string;
  durationMs?: number;
};

type ChatBridgeRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

type ChatBridgeResultRenderState = {
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
};

class ChatBridgeResultRenderComponent extends Container {
  state: ChatBridgeResultRenderState = {
    cachedWidth: undefined,
    cachedLines: undefined,
    cachedSkipped: undefined,
  };
}

function previewCode(value: unknown) {
  const lines = safeString(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const preview = lines[0] || "chat_bridge";
  return preview.length > 100 ? `${preview.slice(0, 97)}...` : preview;
}

function formatChatBridgeCall(
  args: { code?: string; timeout?: number } | undefined,
  theme: any,
): string {
  const preview = previewCode(args?.code);
  const timeout = args?.timeout as number | undefined;
  const timeoutSuffix = timeout
    ? theme.fg("muted", ` (timeout ${timeout}s)`)
    : "";
  return theme.fg("toolTitle", theme.bold(`$ ${preview}`)) + timeoutSuffix;
}

function rebuildChatBridgeResultRenderComponent(
  component: ChatBridgeResultRenderComponent,
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    details?: ChatBridgeDetails;
  },
  options: { expanded: boolean; isPartial: boolean },
  showImages: boolean,
  startedAt: number | undefined,
  endedAt: number | undefined,
  theme: any,
): void {
  const state = component.state;
  component.clear();

  const output = getTextOutput(result as any, showImages).trim();
  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(
              styledOutput,
              CHAT_BRIDGE_PREVIEW_LINES,
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
            return [
              "",
              truncateToWidth(hint, width, "..."),
              ...(state.cachedLines ?? []),
            ];
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

  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;
  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(
          `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
        );
      } else {
        warnings.push(
          `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
        );
      }
    }
    component.addChild(
      new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0),
    );
  }

  if (startedAt !== undefined) {
    const label = options.isPartial ? "Elapsed" : "Took";
    const endTime = endedAt ?? Date.now();
    component.addChild(
      new Text(
        `\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`,
        0,
        0,
      ),
    );
  }
}

const paramsSchema = Type.Object({
  code: Type.String({
    description:
      'TypeScript/JavaScript async function body for the live chat bridge runtime. Available globals: `chat`, `bot`, `internal`, `h`, `store`, `identity`, `helpers`. `chat`, `bot`, `internal`, `store`, and `identity` are bound to the current chat when the current session already belongs to a chat; otherwise use `helpers.useChat("platform/bot:chat")` to get a bound scope for a specific chat. `bot` is intentionally thin; prefer `internal` for most platform operations. Template: `const scope = chat ?? helpers.useChat("telegram/8623230033:-1001234567890"); return await scope.internal.getChat({ chat_id: scope.chat.chatId });` Example send: `const room = helpers.useChat("onebot/2301401877:1067390680"); await room.helpers.send([{ type: "text", text: "hello" }, { type: "image", url: "https://example.com/demo.png" }]); return "sent";` Example platform-specific call: `const scope = helpers.useChat("telegram/8623230033:-1001234567890"); return await scope.internal.getChatMember({ chat_id: scope.chat.chatId, user_id: 123456789 });` Read `${CHAT_BRIDGE_DOC_PATH}` for the runtime reference and more examples.',
  }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, no default timeout).",
    }),
  ),
});

export default function chatBridgeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "chat_bridge",
    label: "chat_bridge",
    description: "Run constrained bridge code against a specific live chat.",
    promptSnippet: "Run constrained bridge code against a specific live chat.",
    promptGuidelines: [
      "Use chat_bridge for tasks such as querying chat or user information, sending messages to a specified chat, sending multimedia content, using platform features for chat management, or building complex interactive chat flows.",
    ],
    parameters: paramsSchema,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const code = safeString((params as any)?.code);
      const timeoutSeconds = Number((params as any)?.timeout);
      if (!code.trim()) throw new Error("chat_bridge_code_required");

      const requestId =
        safeString(toolCallId).trim() ||
        `chat_bridge_${Date.now().toString(36)}`;
      const currentChatKey = parseChatKey(
        ctx.sessionManager?.getSessionName?.() || "",
      );
      const result = await requestDaemonCommand(
        {
          type: "chat_bridge_eval",
          payload: {
            createdAt: new Date().toISOString(),
            requestId,
            currentChatKey,
            code,
            timeoutMs:
              Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
                ? Math.round(timeoutSeconds * 1000)
                : undefined,
            sessionId:
              safeString(ctx.sessionManager?.getSessionId?.() || "").trim() ||
              undefined,
            sessionFile:
              safeString(ctx.sessionManager?.getSessionFile?.() || "").trim() ||
              undefined,
          },
        },
        {
          timeoutMs:
            Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
              ? Math.max(30_000, Math.round(timeoutSeconds * 1000) + 5_000)
              : 30_000,
        },
      );

      const rawOutput = safeString(result?.text).trim() || "undefined";
      const truncation = truncateTail(rawOutput);
      let fullOutputPath: string | undefined;
      if (truncation.truncated) {
        fullOutputPath = getTempFilePath();
        fs.writeFileSync(fullOutputPath, `${rawOutput}\n`, "utf8");
      }

      return {
        content: [{ type: "text", text: truncation.content || "(no output)" }],
        details: {
          truncation: truncation.truncated ? truncation : undefined,
          fullOutputPath,
          currentChatKey,
          requestId,
          auditPath: safeString(result?.auditPath).trim() || undefined,
          durationMs: Number.isFinite(Number(result?.durationMs))
            ? Math.round(Number(result.durationMs))
            : undefined,
        } satisfies ChatBridgeDetails,
      };
    },
    renderCall(args, theme, context) {
      const state = context.state as ChatBridgeRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatChatBridgeCall(args as any, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as ChatBridgeRenderState;
      if (
        state.startedAt !== undefined &&
        options.isPartial &&
        !state.interval
      ) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      const component =
        (context.lastComponent as
          | ChatBridgeResultRenderComponent
          | undefined) ?? new ChatBridgeResultRenderComponent();
      rebuildChatBridgeResultRenderComponent(
        component,
        result as any,
        options,
        context.showImages,
        state.startedAt,
        state.endedAt,
        theme,
      );
      component.invalidate();
      return component;
    },
  });
}
