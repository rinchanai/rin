import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import {
  createSettingsManager,
  type RpcUiSettingsManager,
} from "./settings-manager.js";

export async function loadPersistentSettingsManager(
  profile = resolveRuntimeProfile(),
) {
  const codingAgentModule: any = await loadRinCodingAgent();
  const SettingsManager = codingAgentModule?.SettingsManager;
  if (!SettingsManager?.create) {
    throw new Error("rin_missing_settings_manager");
  }
  return SettingsManager.create(profile.cwd, profile.agentDir);
}

export async function hydrateRpcSettings(
  settingsManager: RpcUiSettingsManager = createSettingsManager(),
  profile = resolveRuntimeProfile(),
) {
  const persistent = await loadPersistentSettingsManager(profile);
  settingsManager.hydrateFrom(persistent);
  return settingsManager;
}
