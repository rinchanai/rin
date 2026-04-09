import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { computeAvailableThinkingLevels } from "./session-helpers.js";

async function getPersistentSettingsManager() {
  try {
    const codingAgentModule: any = await loadRinCodingAgent();
    const SettingsManager = codingAgentModule?.SettingsManager;
    if (!SettingsManager?.create) return null;
    const profile = resolveRuntimeProfile();
    return SettingsManager.create(profile.cwd, profile.agentDir);
  } catch {
    return null;
  }
}

export async function persistRpcSettingsMutation(
  mutate: (settings: any) => void | Promise<void>,
) {
  try {
    const settings = await getPersistentSettingsManager();
    if (!settings) return;
    await mutate(settings);
    await settings.flush?.();
  } catch {}
}

export async function setRpcModel(
  target: any,
  model: any,
  refreshModels: () => Promise<any>,
) {
  if (target.detachedBlankSession) {
    target.model = model;
    target.state.model = model;
    target.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    return;
  }
  await target.call("set_model", {
    provider: model.provider,
    modelId: model.id,
  });
  await refreshModels();
}

export async function cycleRpcModel(
  target: any,
  direction: "forward" | "backward" | undefined,
  getAvailableModels: () => any[],
  refreshModels: () => Promise<any>,
) {
  if (target.detachedBlankSession) {
    const available =
      target.scopedModels.length > 0
        ? target.scopedModels.map((entry: any) => entry.model)
        : getAvailableModels();
    if (available.length <= 1) return undefined;
    const step = direction === "backward" ? -1 : 1;
    const currentIndex = Math.max(
      0,
      available.findIndex(
        (model: any) =>
          model?.provider === target.model?.provider &&
          model?.id === target.model?.id,
      ),
    );
    const next =
      available[(currentIndex + step + available.length) % available.length];
    if (!next) return undefined;
    target.model = next;
    target.state.model = next;
    target.settingsManager.setDefaultModelAndProvider(next.provider, next.id);
    return { model: next, thinkingLevel: target.thinkingLevel };
  }
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
  if (target.detachedBlankSession) return;
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
  if (target.detachedBlankSession) return;
  void target.client.send({ type: "set_steering_mode", mode }).catch(() => {});
}

export function setRpcFollowUpMode(target: any, mode: "all" | "one-at-a-time") {
  target.followUpMode = mode;
  target.settingsManager.setFollowUpMode(mode);
  if (target.detachedBlankSession) return;
  void target.client.send({ type: "set_follow_up_mode", mode }).catch(() => {});
}

export function setRpcAutoCompaction(target: any, enabled: boolean) {
  target.autoCompactionEnabled = enabled;
  if (target.detachedBlankSession) return;
  void target.client
    .send({ type: "set_auto_compaction", enabled })
    .catch(() => {});
}
