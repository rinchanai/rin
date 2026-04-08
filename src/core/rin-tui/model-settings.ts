import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import { computeAvailableThinkingLevels } from "./session-helpers.js";

const RUNTIME_PROFILE = resolveRuntimeProfile();
let persistentSettingsPromise: Promise<any | null> | null = null;

async function getPersistentSettingsManager() {
  if (!persistentSettingsPromise) {
    persistentSettingsPromise = loadRinCodingAgent()
      .then((codingAgentModule: any) => {
        const SettingsManager = codingAgentModule?.SettingsManager;
        if (!SettingsManager?.create) return null;
        return SettingsManager.create(
          RUNTIME_PROFILE.cwd,
          RUNTIME_PROFILE.agentDir,
        );
      })
      .catch(() => null);
  }
  return await persistentSettingsPromise;
}

function persistSettingsMutation(mutate: (settings: any) => void) {
  void getPersistentSettingsManager()
    .then((settings) => {
      if (!settings) return;
      mutate(settings);
    })
    .catch(() => {});
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

export function persistRpcModelSelection(model: any) {
  if (!model?.provider || !model?.id) return;
  persistSettingsMutation((settings) => {
    settings.setDefaultModelAndProvider?.(model.provider, model.id);
  });
}

export function persistRpcThinkingLevel(level: ThinkingLevel) {
  persistSettingsMutation((settings) => {
    settings.setDefaultThinkingLevel?.(level);
  });
}

export function persistRpcSteeringMode(mode: "all" | "one-at-a-time") {
  persistSettingsMutation((settings) => {
    settings.setSteeringMode?.(mode);
  });
}

export function persistRpcFollowUpMode(mode: "all" | "one-at-a-time") {
  persistSettingsMutation((settings) => {
    settings.setFollowUpMode?.(mode);
  });
}

export function persistRpcAutoCompaction(enabled: boolean) {
  persistSettingsMutation((settings) => {
    settings.setCompactionEnabled?.(enabled);
  });
}
