import { loadRinCodingAgent } from "../rin-lib/loader.js";

export async function hydrateRpcSettings(
  settingsManager: any,
  profile: { cwd: string; agentDir: string },
) {
  try {
    const codingAgentModule: any = await loadRinCodingAgent();
    const SettingsManager = codingAgentModule?.SettingsManager;
    if (!SettingsManager?.create) return;
    const settings = SettingsManager.create(profile.cwd, profile.agentDir);
    settingsManager.setShowHardwareCursor(
      Boolean(settings.getShowHardwareCursor?.()),
    );
    settingsManager.setClearOnShrink(Boolean(settings.getClearOnShrink?.()));
    settingsManager.setEditorPaddingX(
      Number(settings.getEditorPaddingX?.() ?? 0),
    );
    settingsManager.setAutocompleteMaxVisible(
      Number(settings.getAutocompleteMaxVisible?.() ?? 8),
    );
    settingsManager.setHideThinkingBlock(
      Boolean(settings.getHideThinkingBlock?.()),
    );
    settingsManager.setTheme(String(settings.getTheme?.() || "dark"));
    settingsManager.setEnableSkillCommands(
      Boolean(settings.getEnableSkillCommands?.()),
    );
    settingsManager.setShowImages(Boolean(settings.getShowImages?.()));
    settingsManager.setImageAutoResize(
      Boolean(settings.getImageAutoResize?.()),
    );
    settingsManager.setBlockImages(Boolean(settings.getBlockImages?.()));
    settingsManager.setTransport(String(settings.getTransport?.() || "stdio"));
    settingsManager.setCollapseChangelog(
      Boolean(settings.getCollapseChangelog?.()),
    );
    settingsManager.setDoubleEscapeAction(
      String(settings.getDoubleEscapeAction?.() || "none"),
    );
    settingsManager.setTreeFilterMode(
      String(settings.getTreeFilterMode?.() || "all"),
    );
    settingsManager.setQuietStartup(Boolean(settings.getQuietStartup?.()));
    settingsManager.setLastChangelogVersion(
      settings.getLastChangelogVersion?.(),
    );
    settingsManager.setEnabledModels(settings.getEnabledModels?.());
    settingsManager.setSteeringMode(settings.getSteeringMode?.() || "all");
    settingsManager.setFollowUpMode(
      settings.getFollowUpMode?.() || "one-at-a-time",
    );
    settingsManager.setCompactionEnabled(
      Boolean(settings.getCompactionEnabled?.()),
    );
    const provider = String(settings.getDefaultProvider?.() || "");
    const modelId = String(settings.getDefaultModel?.() || "");
    if (provider && modelId)
      settingsManager.setDefaultModelAndProvider(provider, modelId);
  } catch {}
}
