type PromptContextMeta = {
  source?: string;
  sentAt?: number;
  chatKey?: string;
  chatName?: string;
  chatType?: string;
  userId?: string;
  nickname?: string;
  identity?: string;
  replyToMessageId?: string;
  attachedFiles?: Array<{ name?: string; path?: string }>;
};

const chatPromptContextQueue: PromptContextMeta[] = [];

export function enqueueChatPromptContext(meta: PromptContextMeta) {
  chatPromptContextQueue.push({ ...meta });
}

export function consumeChatPromptContext(): PromptContextMeta | null {
  return chatPromptContextQueue.shift() || null;
}
