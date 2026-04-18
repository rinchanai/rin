import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "../platform/fs.js";

export type ChatMessagePart =
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

export type ChatOutboxPayload =
  | {
      type: "text_delivery";
      createdAt: string;
      chatKey: string;
      taskId?: string;
      runId?: string;
      requestId?: string;
      text: string;
      replyToMessageId?: string;
      sessionId?: string;
      sessionFile?: string;
    }
  | {
      type: "parts_delivery";
      createdAt: string;
      requestId?: string;
      taskId?: string;
      runId?: string;
      chatKey: string;
      sessionId?: string;
      sessionFile?: string;
      parts: ChatMessagePart[];
    };

export function chatOutboxDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "chat-outbox");
}

export function enqueueChatOutboxPayload(
  agentDir: string,
  payload: ChatOutboxPayload,
) {
  const dir = chatOutboxDir(agentDir);
  ensureDir(dir);
  const base = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = path.join(dir, `${base}.tmp`);
  const filePath = path.join(dir, `${base}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  return filePath;
}
