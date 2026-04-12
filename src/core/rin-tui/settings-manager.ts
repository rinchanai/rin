type UiMode = "all" | "one-at-a-time";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type BackingSettingsManager = {
  getDefaultProvider?: () => string | undefined;
  getDefaultModel?: () => string | undefined;
  setDefaultModelAndProvider?: (provider: string, modelId: string) => void;
  getDefaultThinkingLevel?: () => ThinkingLevel | undefined;
  setDefaultThinkingLevel?: (level: ThinkingLevel) => void;
  getSteeringMode?: () => UiMode;
  setSteeringMode?: (mode: UiMode) => void;
  getFollowUpMode?: () => UiMode;
  setFollowUpMode?: (mode: UiMode) => void;
  getCompactionEnabled?: () => boolean;
  setCompactionEnabled?: (enabled: boolean) => void;
  getQuietStartup?: () => boolean;
  setQuietStartup?: (enabled: boolean) => void;
  flush?: () => void | Promise<void>;
};

type RpcUiSettingsState = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  steeringMode: UiMode;
  followUpMode: UiMode;
  compactionEnabled: boolean;
  quietStartup: boolean;
};

export type RpcUiSettingsManager = ReturnType<typeof createSettingsManager>;

export function createSettingsManager() {
  const state: RpcUiSettingsState = {
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    compactionEnabled: true,
    quietStartup: false,
  };
  let backing: BackingSettingsManager | null = null;

  const api = {
    attach(manager: BackingSettingsManager | null | undefined) {
      backing = manager || null;
      return api;
    },
    hydrateFrom(manager: BackingSettingsManager | null | undefined) {
      if (!manager) return api;
      backing = manager;
      state.defaultProvider = manager.getDefaultProvider?.();
      state.defaultModel = manager.getDefaultModel?.();
      state.defaultThinkingLevel = manager.getDefaultThinkingLevel?.();
      state.steeringMode = manager.getSteeringMode?.() ?? state.steeringMode;
      state.followUpMode = manager.getFollowUpMode?.() ?? state.followUpMode;
      state.compactionEnabled =
        manager.getCompactionEnabled?.() ?? state.compactionEnabled;
      state.quietStartup = manager.getQuietStartup?.() ?? state.quietStartup;
      return api;
    },
    getBackingManager() {
      return backing;
    },
    getDefaultProvider() {
      return state.defaultProvider;
    },
    getDefaultModel() {
      return state.defaultModel;
    },
    setDefaultModelAndProvider(provider: string, modelId: string) {
      state.defaultProvider = provider;
      state.defaultModel = modelId;
      backing?.setDefaultModelAndProvider?.(provider, modelId);
    },
    getDefaultThinkingLevel() {
      return state.defaultThinkingLevel;
    },
    setDefaultThinkingLevel(level: ThinkingLevel) {
      state.defaultThinkingLevel = level;
      backing?.setDefaultThinkingLevel?.(level);
    },
    getSteeringMode() {
      return state.steeringMode;
    },
    setSteeringMode(mode: UiMode) {
      state.steeringMode = mode;
      backing?.setSteeringMode?.(mode);
    },
    getFollowUpMode() {
      return state.followUpMode;
    },
    setFollowUpMode(mode: UiMode) {
      state.followUpMode = mode;
      backing?.setFollowUpMode?.(mode);
    },
    getCompactionEnabled() {
      return state.compactionEnabled;
    },
    setCompactionEnabled(enabled: boolean) {
      state.compactionEnabled = enabled;
      backing?.setCompactionEnabled?.(enabled);
    },
    getQuietStartup() {
      return state.quietStartup;
    },
    setQuietStartup(enabled: boolean) {
      state.quietStartup = enabled;
      backing?.setQuietStartup?.(enabled);
    },
    async flush() {
      await backing?.flush?.();
    },
  };

  return api;
}
