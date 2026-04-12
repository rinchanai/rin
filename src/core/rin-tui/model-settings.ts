import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { computeAvailableThinkingLevels } from "./session-helpers.js";

let persistentSettingsManagerPromise: Promise<any> | null = null;

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
  await target.call("set_model", {
    provider: model.provider,
    modelId: model.id,
  });
  await refreshModels();
}

export async function cycleRpcModel(
  target: any,
  _direction: "forward" | "backward" | undefined,
  refreshModels: () => Promise<any>,
) {
  const data = await target.call("cycle_model");
  await refreshModels();
  return data ?? undefined;
}

export function setRpcThinkingLevel(target: any, level: ThinkingLevel) {
  const available = computeAvailableThinkingLevels(target.model);
  const next = available.includes(level)
    ? level
    : available[available.length - 1];
  target.thinkingLevel = next;
  target.state.thinkingLevel = next;
  void target.client
    .send({ type: "set_thinking_level", level: next })
    .catch(() => {});
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
  target.steeringMode = mode;
  target.settingsManager.setSteeringMode(mode);
  void target.client.send({ type: "set_steering_mode", mode }).catch(() => {});
}

export function setRpcFollowUpMode(target: any, mode: "all" | "one-at-a-time") {
  target.followUpMode = mode;
  target.settingsManager.setFollowUpMode(mode);
  void target.client.send({ type: "set_follow_up_mode", mode }).catch(() => {});
}

export function setRpcAutoCompaction(target: any, enabled: boolean) {
  target.autoCompactionEnabled = enabled;
  void target.client
    .send({ type: "set_auto_compaction", enabled })
    .catch(() => {});
}
