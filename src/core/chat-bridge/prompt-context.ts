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

const koishiPromptContextQueue: PromptContextMeta[] = [];

export function enqueueKoishiPromptContext(meta: PromptContextMeta) {
  koishiPromptContextQueue.push({ ...meta });
}

export function consumeKoishiPromptContext(): PromptContextMeta | null {
  return koishiPromptContextQueue.shift() || null;
}
