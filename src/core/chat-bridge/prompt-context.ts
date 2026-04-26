type PromptContextMeta = {
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
  replyMessage?: {
    messageId?: string;
    userId?: string;
    nickname?: string;
    text?: string;
  };
  attachedFiles?: Array<{ name?: string; path?: string }>;
};

const chatPromptContextQueue: PromptContextMeta[] = [];

export function enqueueChatPromptContext(meta: PromptContextMeta) {
  chatPromptContextQueue.push({ ...meta });
}

export function consumeChatPromptContext(): PromptContextMeta | null {
  return chatPromptContextQueue.shift() || null;
}
