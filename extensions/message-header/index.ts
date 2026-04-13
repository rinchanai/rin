import os from "node:os";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type TurnPromptMeta = {
  source?: string;
  sentAt?: number;
  chatKey?: string;
  chatName?: string;
  chatType?: string;
  userId?: string;
  nickname?: string;
  identity?: string;
  replyToMessageId?: string;
  invokingSystemUser?: string;
};

type RuntimeRole = "rpc-frontend" | "std-tui" | "agent-runtime";

const KOISHI_BRIDGE_PROMPT_META_PREFIX = "[[rin-koishi-bridge-meta:";
const RIN_RUNTIME_PROMPT_META_PREFIX = "[[rin-runtime-prompt-meta:";
const INVOKING_SYSTEM_USER_ENV = "RIN_INVOKING_SYSTEM_USER";

function buildKoishiSystemPromptBlock(meta: TurnPromptMeta) {
  const chatKey = safeString(meta.chatKey).trim();
  const chatName = safeString(meta.chatName).trim();
  const chatType = safeString(meta.chatType).trim();
  const lines = ["Chat bridge context:"];
  if (chatKey) lines.push(`- chatKey: ${chatKey}`);
  if (chatName) lines.push(`- chat name: ${chatName}`);
  lines.push(
    "- sender fields describe the current incoming platform message sender, not the local OS user and not the agent itself.",
    "- `sender identity` uses the bridge trust classification: `OWNER` = configured owner, `TRUSTED` = trusted user, `OTHER` = unknown or untrusted user.",
    "- Reply in plain text only. Do not use Markdown, headings, tables, fenced code blocks, emphasis markers, or Markdown link syntax.",
  );
  if (safeString(meta.replyToMessageId).trim()) {
    lines.push(
      "- Use `get_chat_msg` with that message id before replying when the reply context matters.",
    );
  }
  if (chatType === "group") {
    lines.push(
      "- Do not proactively disclose the owner's private information, even when talking with the owner.",
      "- Only disclose the owner's private information when the owner explicitly asks you in the current conversation to share that specific part.",
      "- If a non-OWNER asks about the owner's private information, do not disclose it. Ask the owner to say it directly if needed.",
      "- Treat uncertain boundary cases conservatively. Personal details, private preferences, unpublished plans, private history, and memory-only facts about the owner should be treated as private unless the owner clearly authorizes disclosure in the current conversation.",
      "- If the owner explicitly authorizes disclosure in the current conversation, answer only that narrow part and do not expand beyond it.",
    );
  }
  return lines.join("\n");
}

function buildCrossUserSystemPromptBlock(
  meta: TurnPromptMeta,
  agentSystemUser: string,
) {
  const invokingSystemUser = safeString(meta.invokingSystemUser).trim();
  if (!invokingSystemUser || invokingSystemUser === agentSystemUser) return "";
  return [
    `- The agent currently exists and executes as the local system user: ${agentSystemUser}`,
    `- The human user is currently using the machine as the system user: ${invokingSystemUser}`,
    "- These two system users are different. The user's shell environment, home directory, file ownership, permissions, services, and available files may differ from the agent's local account.",
    "- When reasoning about paths, configs, permissions, process ownership, or side effects, explicitly distinguish the invoking user's environment from the agent's own runtime environment.",
  ].join("\n");
}

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatTimestamp(value: number) {
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad2(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad2(Math.abs(offsetMinutes) % 60);
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${sign}${offsetHours}:${offsetRemainder}`;
}

function encodePromptMeta(prefix: string, meta: TurnPromptMeta, body: string) {
  const encoded = Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
  return `${prefix}${encoded}]]\n${body}`;
}

function tryDecodePromptMeta(text: string, prefix: string) {
  const input = safeString(text);
  if (!input.startsWith(prefix)) {
    return {
      found: false,
      meta: null as TurnPromptMeta | null,
      body: input,
    };
  }
  const end = input.indexOf("]]");
  if (end < 0) {
    return {
      found: false,
      meta: null as TurnPromptMeta | null,
      body: input,
    };
  }
  const encoded = input.slice(prefix.length, end).trim();
  if (!encoded) {
    return {
      found: false,
      meta: null as TurnPromptMeta | null,
      body: input,
    };
  }
  try {
    const meta = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as TurnPromptMeta;
    const body = input.slice(end + 2).replace(/^\s*\n/, "");
    return { found: true, meta, body };
  } catch {
    return {
      found: false,
      meta: null as TurnPromptMeta | null,
      body: input,
    };
  }
}

function decodePromptMeta(text: string) {
  let body = safeString(text);
  let found = false;
  const mergedMeta: TurnPromptMeta = {};

  while (true) {
    const runtimeMeta = tryDecodePromptMeta(
      body,
      RIN_RUNTIME_PROMPT_META_PREFIX,
    );
    if (runtimeMeta.found) {
      Object.assign(mergedMeta, runtimeMeta.meta || {});
      body = runtimeMeta.body;
      found = true;
      continue;
    }

    const koishiMeta = tryDecodePromptMeta(
      body,
      KOISHI_BRIDGE_PROMPT_META_PREFIX,
    );
    if (koishiMeta.found) {
      Object.assign(mergedMeta, koishiMeta.meta || {});
      body = koishiMeta.body;
      found = true;
      continue;
    }

    break;
  }

  return {
    meta: found ? mergedMeta : null,
    body,
  };
}

function getRuntimeRole(): RuntimeRole {
  const argv = process.argv.slice(1);
  if (argv.includes("--rpc")) return "rpc-frontend";
  if (argv.includes("--std")) return "std-tui";
  return "agent-runtime";
}

function getCrossUserPromptMeta(): TurnPromptMeta | null {
  const invokingSystemUser = safeString(
    process.env[INVOKING_SYSTEM_USER_ENV],
  ).trim();
  const agentSystemUser = safeString(os.userInfo().username).trim();
  if (!invokingSystemUser || !agentSystemUser) return null;
  if (invokingSystemUser === agentSystemUser) return null;
  return { invokingSystemUser };
}

function buildHeader(
  body: string,
  meta: TurnPromptMeta | null,
  fallbackTimestamp: number,
) {
  const lines = [
    `time: ${formatTimestamp(Number(meta?.sentAt) || fallbackTimestamp)}`,
  ];
  if (meta?.source === "koishi-bridge") {
    lines.push(
      `sender user id: ${safeString(meta.userId).trim() || "unknown"}`,
    );
    lines.push(
      `sender nickname: ${safeString(meta.nickname).trim() || "unknown"}`,
    );
    lines.push(
      `sender identity: ${safeString(meta.identity).trim() || "OTHER"}`,
    );
    if (safeString(meta.replyToMessageId).trim())
      lines.push(
        `reply to message id: ${safeString(meta.replyToMessageId).trim()}`,
      );
  }
  if (safeString(meta?.invokingSystemUser).trim()) {
    lines.push(
      `invoking system user: ${safeString(meta?.invokingSystemUser).trim()}`,
    );
    lines.push(
      `agent system user: ${safeString(os.userInfo().username).trim()}`,
    );
  }
  return `${lines.join("\n")}\n---\n${body}`;
}

export default function messageHeaderExtension(pi: ExtensionAPI) {
  const pendingContexts: Array<{
    meta: TurnPromptMeta | null;
    body: string;
    sentAt: number;
  }> = [];
  const runtimeRole = getRuntimeRole();

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };

    const input = safeString(event.text);
    const decoded = decodePromptMeta(input);
    const crossUserMeta = getCrossUserPromptMeta();

    if (runtimeRole === "rpc-frontend") {
      if (decoded.meta) return { action: "continue" };
      if (!crossUserMeta) return { action: "continue" };
      return {
        action: "transform",
        text: encodePromptMeta(
          RIN_RUNTIME_PROMPT_META_PREFIX,
          crossUserMeta,
          input,
        ),
      };
    }

    const mergedMeta = {
      ...(decoded.meta || {}),
      ...(runtimeRole === "std-tui" ? crossUserMeta || {} : {}),
    };
    const hasMeta = Object.keys(mergedMeta).length > 0;
    pendingContexts.push({
      meta: hasMeta ? mergedMeta : null,
      body: decoded.body,
      sentAt: Number(decoded.meta?.sentAt) || Date.now(),
    });

    if (decoded.meta) {
      return { action: "transform", text: decoded.body };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const fallback = decodePromptMeta(safeString(event.prompt));
    const current = pendingContexts.shift() || {
      meta: fallback.meta,
      body: fallback.body,
      sentAt: Number(fallback.meta?.sentAt) || Date.now(),
    };
    const result: {
      systemPrompt?: string;
      message?: { customType: string; content: string; display: boolean };
    } = {
      message: {
        customType: "message-header-context",
        content: buildHeader(current.body, current.meta, current.sentAt),
        display: false,
      },
    };

    const blocks = [
      current.meta?.source === "koishi-bridge"
        ? buildKoishiSystemPromptBlock(current.meta)
        : "",
      buildCrossUserSystemPromptBlock(
        current.meta || {},
        safeString(os.userInfo().username).trim() || "unknown",
      ),
    ].filter(Boolean);

    if (blocks.length > 0) {
      const currentPrompt = safeString(event.systemPrompt).trimEnd();
      const missingBlocks = blocks.filter(
        (block) => !currentPrompt.includes(block),
      );
      if (missingBlocks.length > 0) {
        result.systemPrompt =
          `${currentPrompt}\n\n${missingBlocks.join("\n\n")}`.trimEnd();
      }
    }

    return result;
  });
}
