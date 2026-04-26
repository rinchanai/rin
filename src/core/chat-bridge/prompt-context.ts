import { safeString } from "../text-utils.js";

export type PromptContextMeta = {
  source?: string;
  sentAt?: number;
  triggerKind?: string;
  chatKey?: string;
  chatName?: string;
  chatType?: string;
  userId?: string;
  nickname?: string;
  identity?: string;
  replyToMessageId?: string;
  attachedFiles?: Array<{ name?: string; path?: string }>;
};

export const RIN_RUNTIME_PROMPT_META_PREFIX = "[[rin-runtime-prompt-meta:";

const chatPromptContextQueue: PromptContextMeta[] = [];

export function enqueueChatPromptContext(meta: PromptContextMeta) {
  chatPromptContextQueue.push({ ...meta });
}

export function consumeChatPromptContext(): PromptContextMeta | null {
  return chatPromptContextQueue.shift() || null;
}

export function encodePromptContext(meta: PromptContextMeta, body: string) {
  const encoded = Buffer.from(JSON.stringify({ ...meta }), "utf8").toString(
    "base64",
  );
  return `${RIN_RUNTIME_PROMPT_META_PREFIX}${encoded}]]\n${safeString(body)}`;
}
