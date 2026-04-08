export function buildSettingsSnapshot(settings: any) {
  return {
    showHardwareCursor: Boolean(settings.getShowHardwareCursor?.()),
    clearOnShrink: Boolean(settings.getClearOnShrink?.()),
    editorPaddingX: Number(settings.getEditorPaddingX?.() ?? 0),
    autocompleteMaxVisible: Number(settings.getAutocompleteMaxVisible?.() ?? 8),
    hideThinkingBlock: Boolean(settings.getHideThinkingBlock?.()),
    theme: String(settings.getTheme?.() || "dark"),
    enableSkillCommands: Boolean(settings.getEnableSkillCommands?.()),
    showImages: Boolean(settings.getShowImages?.()),
    imageAutoResize: Boolean(settings.getImageAutoResize?.()),
    blockImages: Boolean(settings.getBlockImages?.()),
    transport: String(settings.getTransport?.() || "sse"),
    collapseChangelog: Boolean(settings.getCollapseChangelog?.()),
    doubleEscapeAction: String(settings.getDoubleEscapeAction?.() || "tree"),
    treeFilterMode: String(settings.getTreeFilterMode?.() || "default"),
    quietStartup: Boolean(settings.getQuietStartup?.()),
    lastChangelogVersion: settings.getLastChangelogVersion?.(),
    enabledModels: settings.getEnabledModels?.(),
    defaultProvider: settings.getDefaultProvider?.(),
    defaultModel: settings.getDefaultModel?.(),
    defaultThinkingLevel: settings.getDefaultThinkingLevel?.(),
    steeringMode: settings.getSteeringMode?.() || "one-at-a-time",
    followUpMode: settings.getFollowUpMode?.() || "one-at-a-time",
    compactionEnabled: Boolean(settings.getCompactionEnabled?.()),
  };
}

export function applySettingsSnapshot(settingsManager: any, snapshot: any) {
  if (!snapshot || typeof snapshot !== "object") return;
  settingsManager.setShowHardwareCursor(Boolean(snapshot.showHardwareCursor));
  settingsManager.setClearOnShrink(Boolean(snapshot.clearOnShrink));
  settingsManager.setEditorPaddingX(Number(snapshot.editorPaddingX ?? 0));
  settingsManager.setAutocompleteMaxVisible(
    Number(snapshot.autocompleteMaxVisible ?? 8),
  );
  settingsManager.setHideThinkingBlock(Boolean(snapshot.hideThinkingBlock));
  settingsManager.setTheme(String(snapshot.theme || "dark"));
  settingsManager.setEnableSkillCommands(Boolean(snapshot.enableSkillCommands));
  settingsManager.setShowImages(Boolean(snapshot.showImages));
  settingsManager.setImageAutoResize(Boolean(snapshot.imageAutoResize));
  settingsManager.setBlockImages(Boolean(snapshot.blockImages));
  settingsManager.setTransport(String(snapshot.transport || "sse"));
  settingsManager.setCollapseChangelog(Boolean(snapshot.collapseChangelog));
  settingsManager.setDoubleEscapeAction(
    String(snapshot.doubleEscapeAction || "tree"),
  );
  settingsManager.setTreeFilterMode(String(snapshot.treeFilterMode || "default"));
  settingsManager.setQuietStartup(Boolean(snapshot.quietStartup));
  settingsManager.setLastChangelogVersion(snapshot.lastChangelogVersion);
  settingsManager.setEnabledModels(snapshot.enabledModels);
  settingsManager.setDefaultThinkingLevel(snapshot.defaultThinkingLevel);
  settingsManager.setSteeringMode(snapshot.steeringMode || "one-at-a-time");
  settingsManager.setFollowUpMode(snapshot.followUpMode || "one-at-a-time");
  settingsManager.setCompactionEnabled(Boolean(snapshot.compactionEnabled));
  if (snapshot.defaultProvider && snapshot.defaultModel) {
    settingsManager.setDefaultModelAndProvider(
      String(snapshot.defaultProvider),
      String(snapshot.defaultModel),
    );
  }
}

export function applySettingsPatch(settings: any, patch: any) {
  if (!patch || typeof patch !== "object") return;
  if ("showImages" in patch) settings.setShowImages?.(Boolean(patch.showImages));
  if ("imageAutoResize" in patch)
    settings.setImageAutoResize?.(Boolean(patch.imageAutoResize));
  if ("blockImages" in patch) settings.setBlockImages?.(Boolean(patch.blockImages));
  if ("enableSkillCommands" in patch)
    settings.setEnableSkillCommands?.(Boolean(patch.enableSkillCommands));
  if ("transport" in patch) settings.setTransport?.(String(patch.transport));
  if ("theme" in patch) settings.setTheme?.(String(patch.theme));
  if ("hideThinkingBlock" in patch)
    settings.setHideThinkingBlock?.(Boolean(patch.hideThinkingBlock));
  if ("collapseChangelog" in patch)
    settings.setCollapseChangelog?.(Boolean(patch.collapseChangelog));
  if ("quietStartup" in patch)
    settings.setQuietStartup?.(Boolean(patch.quietStartup));
  if ("doubleEscapeAction" in patch)
    settings.setDoubleEscapeAction?.(String(patch.doubleEscapeAction));
  if ("treeFilterMode" in patch)
    settings.setTreeFilterMode?.(String(patch.treeFilterMode));
  if ("showHardwareCursor" in patch)
    settings.setShowHardwareCursor?.(Boolean(patch.showHardwareCursor));
  if ("editorPaddingX" in patch)
    settings.setEditorPaddingX?.(Number(patch.editorPaddingX));
  if ("autocompleteMaxVisible" in patch)
    settings.setAutocompleteMaxVisible?.(Number(patch.autocompleteMaxVisible));
  if ("clearOnShrink" in patch)
    settings.setClearOnShrink?.(Boolean(patch.clearOnShrink));
  if ("steeringMode" in patch)
    settings.setSteeringMode?.(patch.steeringMode === "all" ? "all" : "one-at-a-time");
  if ("followUpMode" in patch)
    settings.setFollowUpMode?.(patch.followUpMode === "all" ? "all" : "one-at-a-time");
  if ("compactionEnabled" in patch)
    settings.setCompactionEnabled?.(Boolean(patch.compactionEnabled));
  if ("defaultThinkingLevel" in patch && patch.defaultThinkingLevel)
    settings.setDefaultThinkingLevel?.(patch.defaultThinkingLevel);
  if (patch.defaultProvider && patch.defaultModel)
    settings.setDefaultModelAndProvider?.(
      String(patch.defaultProvider),
      String(patch.defaultModel),
    );
}
