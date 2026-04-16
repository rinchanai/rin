
import { getAgentDir, keyHint, truncateToVisualLines, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import {
  getTextOutput,
  replaceTabs,
} from "../pi/render-utils.js";

async function loadMessageStoreModule() {
  return await import("./message-store.js");
}

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

type GetChatMessageDetails = {
  messageId: string;
  chatKey?: string;
  matches: any[];
  userText?: string;
  truncation?: TruncationResult;
};

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatGetChatMessageCall(args: any, theme: any) {
  const messageId = safeString(args?.messageId).trim();
  const chatKey = safeString(args?.chatKey).trim();
  return [
    theme.fg("toolTitle", theme.bold("get_chat_msg")),
    messageId ? ` ${theme.fg("accent", messageId)}` : "",
    chatKey ? ` ${theme.fg("muted", chatKey)}` : "",
  ].join("");
}

function formatGetChatMessageResult(
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

export default function chatGetMessageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_chat_msg",
    label: "Get Chat Message",
    description: "Get a specific chat message.",
    promptSnippet: "Get a specific chat message.",
    promptGuidelines: [],
    parameters: Type.Object({
      messageId: Type.String({
        description: "Platform message ID to look up.",
      }),
      chatKey: Type.Optional(
        Type.String({
          description:
            "Optional chat to disambiguate duplicated platform message IDs.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(formatGetChatMessageCall(args, theme), 0, 0);
    },
    execute: (async (_toolCallId, params) => {
      const messageId = safeString((params as any)?.messageId).trim();
      const chatKey = safeString((params as any)?.chatKey).trim() || undefined;
      if (!messageId) throw new Error("chat_get_message_messageId_required");

      const agentDir = getAgentDir();
      const { normalizeChatMessageLookup, describeChatMessageRecord } =
        await loadMessageStoreModule();
      const matches = normalizeChatMessageLookup(agentDir, messageId, chatKey);
      if (!matches.length) {
        return {
          content: [
            {
              type: "text",
              text: `Message not found: ${messageId}${chatKey ? ` (chatKey=${chatKey})` : ""}`,
            },
          ],
          details: {
            messageId,
            chatKey,
            matches,
          } satisfies GetChatMessageDetails,
          isError: true,
        };
      }

      const text = matches
        .map((item: any, index: number) => {
          const body = describeChatMessageRecord(item);
          return matches.length > 1 ? `match ${index + 1}\n${body}` : body;
        })
        .join("\n\n");
      const agentTruncation = truncateHead(text);
      const userTruncation = truncateHead(text);
      let outputText = agentTruncation.content;
      if (agentTruncation.truncated) {
        if (agentTruncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing ${agentTruncation.outputLines} of ${agentTruncation.totalLines} lines.]`;
        } else {
          outputText += `\n\n[Showing ${agentTruncation.outputLines} of ${agentTruncation.totalLines} lines (${formatSize(agentTruncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
        }
      }

      return {
        content: [{ type: "text", text: outputText }],
        details: {
          messageId,
          chatKey,
          matches,
          userText: userTruncation.content,
          truncation: userTruncation.truncated ? userTruncation : undefined,
        } satisfies GetChatMessageDetails,
        isError: false,
      };
    }) as any,
    renderResult(result: any, options, theme, context) {
      const details = result.details as GetChatMessageDetails | undefined;
      if (!result.isError) {
        return new Text(
          formatGetChatMessageResult(
            result,
            options,
            theme,
            context.showImages,
          ),
          0,
          0,
        );
      }
      const fallback =
        result.content?.[0]?.type === "text"
          ? result.content[0].text
          : "(no output)";
      return new Text(String(details?.userText || fallback), 0, 0);
    },
  });
}
