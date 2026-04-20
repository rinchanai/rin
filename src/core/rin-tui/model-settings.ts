import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { computeAvailableThinkingLevels } from "./session-helpers.js";

const RPC_MODE_VALUES = ["all", "one-at-a-time"] as const;
const DEFAULT_RPC_MODE = "one-at-a-time";

let persistentSettingsManagerPromise: Promise<any> | null = null;

function setRpcTargetState(target: any, key: string, value: unknown) {
  target[key] = value;
  if (target?.state && typeof target.state === "object") {
    target.state[key] = value;
  }
}

function sendRpcClientMessage(target: any, payload: Record<string, unknown>) {
  void target?.client?.send?.(payload).catch(() => {});
}

function normalizeRpcMode(
  mode: string,
  fallback: (typeof RPC_MODE_VALUES)[number] = DEFAULT_RPC_MODE,
): (typeof RPC_MODE_VALUES)[number] {
  return RPC_MODE_VALUES.includes(mode as (typeof RPC_MODE_VALUES)[number])
    ? (mode as (typeof RPC_MODE_VALUES)[number])
    : fallback;
}

function resolveRpcThinkingLevel(target: any, level: ThinkingLevel) {
  const available = computeAvailableThinkingLevels(target?.model);
  return (
    available.find((item) => item === level) ??
    available[available.length - 1] ??
    target?.thinkingLevel ??
    "off"
  );
}

async function runRpcModelMutation(
  target: any,
  command: Record<string, unknown>,
  refreshModels: () => Promise<any>,
) {
  const data = await target.call(command.type, command);
  await refreshModels();
  return data ?? undefined;
}

export async function getPersistentSettingsManager() {
  if (!persistentSettingsManagerPromise) {
    persistentSettingsManagerPromise = (async () => {
      const codingAgentModule: any = await loadRinCodingAgent();
      const SettingsManager = codingAgentModule?.SettingsManager;
      if (!SettingsManager?.create) {
        throw new Error("rin_missing_settings_manager");
      }
      const profile = resolveRuntimeProfile();
      return SettingsManager.create(profile.cwd, profile.agentDir);
    })().catch((error) => {
      persistentSettingsManagerPromise = null;
      throw error;
    });
  }
  return await persistentSettingsManagerPromise;
}

export async function persistRpcSettingsMutation(
  mutate: (settings: any) => void | Promise<void>,
) {
  const settings = await getPersistentSettingsManager();
  await mutate(settings);
  await settings.flush?.();
}

export async function setRpcModel(
  target: any,
  model: any,
  refreshModels: () => Promise<any>,
) {
  await runRpcModelMutation(
    target,
    {
      type: "set_model",
      provider: model?.provider,
      modelId: model?.id,
    },
    refreshModels,
  );
}

export async function cycleRpcModel(
  target: any,
  _direction: "forward" | "backward" | undefined,
  refreshModels: () => Promise<any>,
) {
  return await runRpcModelMutation(
    target,
    { type: "cycle_model" },
    refreshModels,
  );
}

export function setRpcThinkingLevel(target: any, level: ThinkingLevel) {
  const next = resolveRpcThinkingLevel(target, level);
  setRpcTargetState(target, "thinkingLevel", next);
  sendRpcClientMessage(target, { type: "set_thinking_level", level: next });
}

export function cycleRpcThinkingLevel(target: any): ThinkingLevel | undefined {
  const levels = computeAvailableThinkingLevels(target.model);
  if (levels.length <= 1) return undefined;
  const next =
    levels[
      (Math.max(0, levels.indexOf(target.thinkingLevel)) + 1) % levels.length
    ];
  setRpcThinkingLevel(target, next);
  return next;
}

export function setRpcSteeringMode(target: any, mode: "all" | "one-at-a-time") {
  const next = normalizeRpcMode(mode, normalizeRpcMode(target?.steeringMode, "all"));
  setRpcTargetState(target, "steeringMode", next);
  target?.settingsManager?.setSteeringMode?.(next);
  sendRpcClientMessage(target, { type: "set_steering_mode", mode: next });
}

export function setRpcFollowUpMode(target: any, mode: "all" | "one-at-a-time") {
  const next = normalizeRpcMode(
    mode,
    normalizeRpcMode(target?.followUpMode, DEFAULT_RPC_MODE),
  );
  setRpcTargetState(target, "followUpMode", next);
  target?.settingsManager?.setFollowUpMode?.(next);
  sendRpcClientMessage(target, { type: "set_follow_up_mode", mode: next });
}

export function setRpcAutoCompaction(target: any, enabled: boolean) {
  setRpcTargetState(target, "autoCompactionEnabled", Boolean(enabled));
  sendRpcClientMessage(target, {
    type: "set_auto_compaction",
    enabled: Boolean(enabled),
  });
}
