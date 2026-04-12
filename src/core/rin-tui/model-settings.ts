import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { computeAvailableThinkingLevels } from "./session-helpers.js";
import { loadPersistentSettingsManager } from "./settings-hydration.js";

let persistentSettingsManagerPromise: Promise<any> | null = null;

export async function getPersistentSettingsManager() {
  if (!persistentSettingsManagerPromise) {
    persistentSettingsManagerPromise = loadPersistentSettingsManager().catch(
      (error) => {
        persistentSettingsManagerPromise = null;
        throw error;
      },
    );
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

function hasRpcCall(target: any) {
  return typeof target?.call === "function";
}

function hasRemoteSession(target: any) {
  return Boolean(target?.sessionId || target?.sessionFile);
}

function shouldSendRpc(target: any) {
  return hasRemoteSession(target) && Boolean(target?.client);
}

function applyLocalModel(target: any, model: any) {
  target.model = model;
  target.state.model = model;
  target.settingsManager?.setDefaultModelAndProvider?.(
    String(model?.provider || ""),
    String(model?.id || ""),
  );
}

export async function setRpcModel(
  target: any,
  model: any,
  refreshModels: () => Promise<any>,
) {
  if (hasRpcCall(target) && hasRemoteSession(target)) {
    await target.call("set_model", {
      provider: model.provider,
      modelId: model.id,
    });
    await refreshModels();
    return;
  }
  applyLocalModel(target, model);
}

export async function cycleRpcModel(
  target: any,
  direction: "forward" | "backward" | undefined,
  refreshModels: () => Promise<any>,
) {
  if (hasRpcCall(target) && hasRemoteSession(target)) {
    const data = await target.call("cycle_model");
    await refreshModels();
    return data ?? undefined;
  }
  const models = await refreshModels();
  const available = Array.isArray(models)
    ? models.map((entry: any) => entry?.model ?? entry).filter(Boolean)
    : target?.scopedModels
        ?.map((entry: any) => entry?.model ?? entry)
        .filter(Boolean) || [];
  if (!available.length) return undefined;
  const currentIndex = Math.max(
    0,
    available.findIndex(
      (entry: any) =>
        entry?.provider === target?.model?.provider &&
        entry?.id === target?.model?.id,
    ),
  );
  const delta = direction === "backward" ? -1 : 1;
  const next =
    available[(currentIndex + delta + available.length) % available.length];
  applyLocalModel(target, next);
  return { model: next };
}

export function setRpcThinkingLevel(target: any, level: ThinkingLevel) {
  const available = computeAvailableThinkingLevels(target.model);
  const next = available.includes(level)
    ? level
    : available[available.length - 1];
  target.thinkingLevel = next;
  target.state.thinkingLevel = next;
  target.settingsManager?.setDefaultThinkingLevel?.(next);
  if (!shouldSendRpc(target)) return;
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
  target.settingsManager?.setSteeringMode?.(mode);
  if (!shouldSendRpc(target)) return;
  void target.client.send({ type: "set_steering_mode", mode }).catch(() => {});
}

export function setRpcFollowUpMode(target: any, mode: "all" | "one-at-a-time") {
  target.followUpMode = mode;
  target.settingsManager?.setFollowUpMode?.(mode);
  if (!shouldSendRpc(target)) return;
  void target.client.send({ type: "set_follow_up_mode", mode }).catch(() => {});
}

export function setRpcAutoCompaction(target: any, enabled: boolean) {
  target.autoCompactionEnabled = enabled;
  target.settingsManager?.setCompactionEnabled?.(enabled);
  if (!shouldSendRpc(target)) return;
  void target.client
    .send({ type: "set_auto_compaction", enabled })
    .catch(() => {});
}
