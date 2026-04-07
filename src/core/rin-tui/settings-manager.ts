export function createSettingsManager() {
  const values = {
    showHardwareCursor: false,
    clearOnShrink: false,
    editorPaddingX: 0,
    autocompleteMaxVisible: 8,
    hideThinkingBlock: false,
    theme: "dark",
    enableSkillCommands: false,
    showImages: true,
    imageAutoResize: true,
    blockImages: false,
    transport: "stdio",
    collapseChangelog: false,
    doubleEscapeAction: "none",
    treeFilterMode: "all",
    quietStartup: false,
    versionCheck: false,
    codeBlockIndent: "  ",
    branchSummarySkipPrompt: false,
    lastChangelogVersion: undefined as string | undefined,
    enabledModels: undefined as string[] | undefined,
    defaultProvider: undefined as string | undefined,
    defaultModel: undefined as string | undefined,
    steeringMode: "all" as "all" | "one-at-a-time",
    followUpMode: "one-at-a-time" as "all" | "one-at-a-time",
    compactionEnabled: true,
  };
  const globalSettings = {
    packages: [] as any[],
    extensions: [] as string[],
    skills: [] as string[],
    prompts: [] as string[],
    themes: [] as string[],
  };
  const projectSettings = {
    packages: [] as any[],
    extensions: [] as string[],
    skills: [] as string[],
    prompts: [] as string[],
    themes: [] as string[],
  };
  return {
    getShowHardwareCursor: () => values.showHardwareCursor,
    getClearOnShrink: () => values.clearOnShrink,
    getEditorPaddingX: () => values.editorPaddingX,
    getAutocompleteMaxVisible: () => values.autocompleteMaxVisible,
    getHideThinkingBlock: () => values.hideThinkingBlock,
    getTheme: () => values.theme,
    getEnableSkillCommands: () => values.enableSkillCommands,
    getShowImages: () => values.showImages,
    getImageAutoResize: () => values.imageAutoResize,
    getBlockImages: () => values.blockImages,
    getTransport: () => values.transport,
    getCollapseChangelog: () => values.collapseChangelog,
    getDoubleEscapeAction: () => values.doubleEscapeAction,
    getTreeFilterMode: () => values.treeFilterMode,
    getQuietStartup: () => values.quietStartup,
    getVersionCheck: () => values.versionCheck,
    getLastChangelogVersion: () => values.lastChangelogVersion,
    getEnabledModels: () => values.enabledModels,
    getSteeringMode: () => values.steeringMode,
    getFollowUpMode: () => values.followUpMode,
    getCompactionEnabled: () => values.compactionEnabled,
    getCodeBlockIndent: () => values.codeBlockIndent,
    getBranchSummarySkipPrompt: () => values.branchSummarySkipPrompt,
    getGlobalSettings: () => ({ ...globalSettings }),
    getProjectSettings: () => ({ ...projectSettings }),
    setShowImages: (v: boolean) => {
      values.showImages = v;
    },
    setImageAutoResize: (v: boolean) => {
      values.imageAutoResize = v;
    },
    setBlockImages: (v: boolean) => {
      values.blockImages = v;
    },
    setEnableSkillCommands: (v: boolean) => {
      values.enableSkillCommands = v;
    },
    setTransport: (v: string) => {
      values.transport = v;
    },
    setTheme: (v: string) => {
      values.theme = v;
    },
    setHideThinkingBlock: (v: boolean) => {
      values.hideThinkingBlock = v;
    },
    setCollapseChangelog: (v: boolean) => {
      values.collapseChangelog = v;
    },
    setQuietStartup: (v: boolean) => {
      values.quietStartup = v;
    },
    setVersionCheck: (v: boolean) => {
      values.versionCheck = v;
    },
    setDoubleEscapeAction: (v: string) => {
      values.doubleEscapeAction = v;
    },
    setTreeFilterMode: (v: string) => {
      values.treeFilterMode = v;
    },
    setShowHardwareCursor: (v: boolean) => {
      values.showHardwareCursor = v;
    },
    setEditorPaddingX: (v: number) => {
      values.editorPaddingX = v;
    },
    setAutocompleteMaxVisible: (v: number) => {
      values.autocompleteMaxVisible = v;
    },
    setClearOnShrink: (v: boolean) => {
      values.clearOnShrink = v;
    },
    setLastChangelogVersion: (v?: string) => {
      values.lastChangelogVersion = v;
    },
    setEnabledModels: (v?: string[]) => {
      values.enabledModels = v && v.length ? [...v] : undefined;
    },
    setSteeringMode: (v: "all" | "one-at-a-time") => {
      values.steeringMode = v;
    },
    setFollowUpMode: (v: "all" | "one-at-a-time") => {
      values.followUpMode = v;
    },
    setCompactionEnabled: (v: boolean) => {
      values.compactionEnabled = v;
    },
    setDefaultModelAndProvider: (provider: string, modelId: string) => {
      values.defaultProvider = provider;
      values.defaultModel = modelId;
    },
    setPackages: (v: any[]) => {
      globalSettings.packages = [...v];
    },
    setProjectPackages: (v: any[]) => {
      projectSettings.packages = [...v];
    },
    setExtensionPaths: (v: string[]) => {
      globalSettings.extensions = [...v];
    },
    setProjectExtensionPaths: (v: string[]) => {
      projectSettings.extensions = [...v];
    },
    setSkillPaths: (v: string[]) => {
      globalSettings.skills = [...v];
    },
    setProjectSkillPaths: (v: string[]) => {
      projectSettings.skills = [...v];
    },
    setPromptTemplatePaths: (v: string[]) => {
      globalSettings.prompts = [...v];
    },
    setProjectPromptTemplatePaths: (v: string[]) => {
      projectSettings.prompts = [...v];
    },
    setThemePaths: (v: string[]) => {
      globalSettings.themes = [...v];
    },
    setProjectThemePaths: (v: string[]) => {
      projectSettings.themes = [...v];
    },
  };
}
