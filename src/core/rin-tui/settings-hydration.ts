import { applySettingsSnapshot } from "../rin-lib/settings-rpc.js";

export function hydrateRpcSettings(settingsManager: any, snapshot: any) {
  try {
    applySettingsSnapshot(settingsManager, snapshot);
  } catch {}
}
