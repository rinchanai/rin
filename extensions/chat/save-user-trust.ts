import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

async function loadSupportModule() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = [
    path.join(root, "core", "rin-koishi", "support.js"),
    path.join(root, "dist", "core", "rin-koishi", "support.js"),
  ];
  const distPath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!distPath) {
    throw new Error(`rin_koishi_support_not_found:${candidates.join(" | ")}`);
  }
  return await import(pathToFileURL(distPath).href);
}

async function loadMessageStoreModule() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = [
    path.join(root, "core", "rin-koishi", "message-store.js"),
    path.join(root, "dist", "core", "rin-koishi", "message-store.js"),
  ];
  const distPath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!distPath) {
    throw new Error(
      `rin_koishi_message_store_not_found:${candidates.join(" | ")}`,
    );
  }
  return await import(pathToFileURL(distPath).href);
}

const paramsSchema = Type.Object({
  trust: Type.Union([Type.Literal("TRUSTED"), Type.Literal("OTHER")], {
    description:
      "Saved trust level for this chat user. Allowed values: `TRUSTED` or `OTHER`.",
  }),
  messageId: Type.Optional(
    Type.String({
      description:
        "Platform message ID whose sender should be updated. Use this to save trust from a known chat message.",
    }),
  ),
  chatKey: Type.Optional(
    Type.String({
      description:
        "Optional chat to disambiguate duplicated platform message IDs, or explicit chat when platform/userId are provided.",
    }),
  ),
  platform: Type.Optional(
    Type.String({
      description:
        "Platform name like telegram or onebot. Required with userId when messageId is omitted.",
    }),
  ),
  userId: Type.Optional(
    Type.String({
      description:
        "Platform user ID to update. Required with platform when messageId is omitted.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Optional display name hint to save with this user record.",
    }),
  ),
});

export default function saveChatUserTrustExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "save_chat_user_identity",
    label: "Save Chat User Identity",
    description:
      "Create or update saved identity info for a chat user.",
    promptSnippet: "Save identity info for a chat user.",
    promptGuidelines: [],
    parameters: paramsSchema,
    execute: (async (_toolCallId, params) => {
      const trust = safeString((params as any)?.trust).trim();
      const messageId = safeString((params as any)?.messageId).trim();
      const chatKey = safeString((params as any)?.chatKey).trim();
      const platformInput = safeString((params as any)?.platform).trim();
      const userIdInput = safeString((params as any)?.userId).trim();
      const nameInput = safeString((params as any)?.name).trim();

      let platform = platformInput;
      let userId = userIdInput;
      let name = nameInput;

      if (messageId) {
        const { normalizeKoishiMessageLookup } = await loadMessageStoreModule();
        const matches = normalizeKoishiMessageLookup(
          getAgentDir(),
          messageId,
          chatKey || undefined,
        );
        if (!matches.length) {
          throw new Error(
            `Message not found: ${messageId}${chatKey ? ` (chatKey=${chatKey})` : ""}`,
          );
        }
        const target = matches[0];
        platform = safeString(target?.platform).trim();
        userId = safeString(target?.userId).trim();
        if (!name) name = safeString(target?.nickname || target?.chatName).trim();
      }

      if (!platform || !userId) {
        throw new Error(
          "Provide either messageId (optionally with chatKey) or platform and userId.",
        );
      }

      const { setIdentityTrust } = await loadSupportModule();
      const result = setIdentityTrust({
        dataDir: path.join(getAgentDir(), "data"),
        platform,
        userId,
        trust: trust as "TRUSTED" | "OTHER",
        name: name || undefined,
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `Saved chat user identity: ${result.trust}`,
              `platform=${result.platform}`,
              `userId=${result.userId}`,
              result.name ? `name=${result.name}` : "",
              `personId=${result.personId}`,
              result.path,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: result,
        isError: false,
      };
    }) as any,
  });
}
