import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  promptChatBridgeSetup,
  type ChatBridgePromptApi,
} from "../../src/core/chat-bridge/setup.js";
import { resolveRuntimeProfile } from "../../src/core/rin-lib/runtime.js";
import {
  ensureKoishiSidecar,
  getKoishiSidecarStatus,
  stopKoishiSidecar,
} from "../../src/core/rin-koishi/service.js";
import { readJsonFile, writeJsonFile } from "../../src/core/rin-koishi/support.js";

const CHAT_BRIDGE_COMMAND_CANCELLED = "chat_bridge_setup_cancelled";

function formatSelectLabel(item: { label?: string; hint?: string }, index: number) {
  const label = String(item.label || "").trim() || `Option ${index + 1}`;
  const hint = String(item.hint || "").trim();
  return hint ? `${label} — ${hint}` : label;
}

function createUiPromptApi(ui: any): ChatBridgePromptApi {
  return {
    ensureNotCancelled<T>(value: T | symbol | undefined | null) {
      if (value === undefined || value === null) {
        throw new Error(CHAT_BRIDGE_COMMAND_CANCELLED);
      }
      return value as T;
    },
    async select(options: any) {
      const items = Array.isArray(options?.options)
        ? options.options.map((item: any, index: number) => {
            if (item && typeof item === "object") {
              return {
                value: item.value,
                label: formatSelectLabel(item, index),
              };
            }
            const text = String(item ?? `Option ${index + 1}`);
            return { value: item, label: text };
          })
        : [];
      const labels = items.map((item) => item.label);
      const choice = await ui.select(String(options?.message || "Choose:"), labels);
      if (choice === undefined) return undefined;
      const index = labels.indexOf(String(choice));
      return index >= 0 ? items[index].value : undefined;
    },
    async text(options: any) {
      const title = String(options?.message || "Input");
      const placeholderParts = [
        String(options?.placeholder || "").trim(),
        String(options?.defaultValue || "").trim()
          ? `default: ${String(options.defaultValue).trim()}`
          : "",
      ].filter(Boolean);
      const placeholder = placeholderParts.join(" · ") || undefined;
      for (;;) {
        const raw = await ui.input(title, placeholder);
        if (raw === undefined) return undefined;
        const text = String(raw || "").trim() || String(options?.defaultValue || "").trim();
        const error = typeof options?.validate === "function" ? options.validate(text) : undefined;
        if (error) {
          ui.notify(String(error), "warning");
          continue;
        }
        return text;
      }
    },
    async confirm(options: any) {
      return await ui.confirm("Chat bridge", String(options?.message || "Confirm?"));
    },
  };
}

async function restartChatBridgeSidecars(agentDir: string) {
  const status = getKoishiSidecarStatus(agentDir);
  const instances = Array.isArray(status?.instances) ? status.instances : [];
  if (!instances.length) return { restarted: 0, pending: true };
  let restarted = 0;
  for (const instance of instances) {
    const instanceId = String(instance?.instanceId || "").trim();
    if (!instanceId) continue;
    const entryPath = String(instance?.entryPath || "").trim() || undefined;
    await stopKoishiSidecar(agentDir, { instanceId }).catch(() => {});
    await ensureKoishiSidecar(agentDir, { instanceId, entryPath }).catch(() => {});
    restarted += 1;
  }
  return { restarted, pending: false };
}

export default function configureChatBridgeCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand("chat", {
    description: "Configure an official chat bridge adapter.",
    handler: async (_args, ctx) => {
      const prompt = createUiPromptApi(ctx.ui);
      const profile = resolveRuntimeProfile();
      const settingsPath = path.join(profile.agentDir, "settings.json");
      const settings = readJsonFile<any>(settingsPath, {});
      settings.koishi ||= {};

      let result;
      try {
        result = await promptChatBridgeSetup(prompt);
      } catch (error: any) {
        if (String(error?.message || error) === CHAT_BRIDGE_COMMAND_CANCELLED) {
          ctx.ui.notify("Chat bridge setup cancelled.", "info");
          return;
        }
        throw error;
      }

      const adapterKey = String(result?.adapterKey || "").trim();
      if (!adapterKey || !result?.koishiConfig) {
        ctx.ui.notify("Chat bridge setup skipped.", "info");
        return;
      }

      if (settings.koishi[adapterKey] !== undefined) {
        const overwrite = await ctx.ui.confirm(
          "Chat bridge",
          `Replace the existing ${result.koishiDescription} configuration?`,
        );
        if (!overwrite) {
          ctx.ui.notify("Chat bridge setup cancelled.", "info");
          return;
        }
      }

      settings.koishi[adapterKey] = result.koishiConfig[adapterKey];
      writeJsonFile(settingsPath, settings);

      const restart = await restartChatBridgeSidecars(profile.agentDir);
      const lines = [
        `Chat bridge updated: ${result.koishiDescription}`,
        result.koishiDetail,
      ].filter(Boolean);
      if (restart.pending) {
        lines.push("No active chat bridge sidecar was running. The change will apply on the next daemon start.");
      } else {
        lines.push(`Restarted chat bridge sidecar instances: ${restart.restarted}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    },
  });
}
