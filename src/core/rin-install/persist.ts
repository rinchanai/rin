import fs from "node:fs";

import {
  dropLegacyChatSettings,
  normalizeStoredChatSettings,
} from "../chat/settings.js";
import { isNonArrayObject, loadFirstValidCandidate } from "./candidate-loader.js";
import {
  defaultHomeForUser,
  installAuthPath,
  installerManifestPaths,
  installSettingsPath,
} from "./paths.js";

function resolveInstallOwner(
  targetUser: string,
  findSystemUser: (targetUser: string) => any,
) {
  const target = findSystemUser(targetUser) as any;
  const ownerUser = target?.name || targetUser;
  return {
    ownerUser,
    ownerGroup: target?.gid,
    ownerHome: target?.home || defaultHomeForUser(ownerUser),
  };
}

function writeInstallerJson(
  filePath: string,
  value: unknown,
  options: {
    elevated?: boolean;
    ownerUser?: string;
    ownerGroup?: string | number;
  },
  deps: {
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
  },
) {
  if (options.elevated) {
    deps.writeJsonFileWithPrivilege(
      filePath,
      value,
      options.ownerUser,
      options.ownerGroup,
    );
    return;
  }
  deps.writeJsonFile(filePath, value);
}

function removeFile(
  filePath: string,
  elevated: boolean,
  runPrivileged: (command: string, args: string[]) => void,
) {
  try {
    if (elevated) {
      runPrivileged("rm", ["-f", filePath]);
      return;
    }
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function mergeInstalledChatSettings(settingsJson: any, chatConfig?: any) {
  const normalized = normalizeStoredChatSettings(settingsJson, {
    ensureChat: Boolean(chatConfig && typeof chatConfig === "object"),
  });
  if (!chatConfig || typeof chatConfig !== "object") return normalized;
  for (const [adapterKey, adapterConfig] of Object.entries(chatConfig)) {
    if (adapterConfig === undefined) continue;
    normalized.chat[adapterKey] = adapterConfig;
  }
  return normalized;
}

export function reconcileInstallerManifest(
  options: {
    targetUser: string;
    installDir: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    chatConfig?: any;
    elevated?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    ensureDir: (dir: string) => void;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    runPrivileged: (command: string, args: string[]) => void;
  },
) {
  const { ownerUser, ownerGroup, ownerHome } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);

  const manifestPaths = installerManifestPaths(options.installDir, ownerHome);
  const {
    manifestPath,
    locatorManifestPath,
    legacyManifestPath,
    legacyLocatorManifestPath,
  } = manifestPaths;
  const manifestJson: any =
    loadFirstValidCandidate(
      manifestPaths.recoveryPaths,
      (filePath) =>
        deps.readInstallerJson<any>(filePath, null, Boolean(options.elevated)),
      (value) => (isNonArrayObject(value) ? value : null),
    ) || {};
  manifestJson.targetUser = options.targetUser;
  manifestJson.installDir = options.installDir;
  if (options.provider) manifestJson.defaultProvider = options.provider;
  if (options.modelId) manifestJson.defaultModel = options.modelId;
  if (options.thinkingLevel)
    manifestJson.defaultThinkingLevel = options.thinkingLevel;
  if (options.chatConfig) manifestJson.chat = options.chatConfig;
  dropLegacyChatSettings(manifestJson);
  manifestJson.updatedAt = new Date().toISOString();

  for (const filePath of manifestPaths.writePaths) {
    writeInstallerJson(
      filePath,
      manifestJson,
      {
        elevated: options.elevated,
        ownerUser,
        ownerGroup,
      },
      deps,
    );
  }
  for (const filePath of manifestPaths.cleanupPaths) {
    removeFile(filePath, Boolean(options.elevated), deps.runPrivileged);
  }

  return {
    manifestPath,
    locatorManifestPath,
    legacyManifestPath,
    legacyLocatorManifestPath,
  };
}

export function normalizeInstalledChatSettings(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
  },
) {
  const { ownerUser, ownerGroup } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = normalizeStoredChatSettings(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
  );
  writeInstallerJson(
    settingsPath,
    settingsJson,
    {
      elevated: options.elevated,
      ownerUser,
      ownerGroup,
    },
    deps,
  );
  return { settingsPath };
}

export async function persistInstallerOutputs(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    chatConfig: any;
    authData: any;
    elevated?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    ensureDir: (dir: string) => void;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    launcherMetadataPathForUser: (userName: string) => string;
    readJsonFile: <T>(filePath: string, fallback: T) => T;
    writeLaunchersForUser: (userName: string, installDir: string) => any;
    reconcileInstallerManifest: typeof reconcileInstallerManifest;
    runPrivileged: (command: string, args: string[]) => void;
  },
) {
  const { ownerUser, ownerGroup } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);

  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = mergeInstalledChatSettings(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
    options.chatConfig,
  );
  if (options.provider) settingsJson.defaultProvider = options.provider;
  if (options.modelId) settingsJson.defaultModel = options.modelId;
  if (options.thinkingLevel)
    settingsJson.defaultThinkingLevel = options.thinkingLevel;

  const authPath = installAuthPath(options.installDir);
  const authJson = deps.readInstallerJson<any>(
    authPath,
    {},
    Boolean(options.elevated),
  );
  const nextAuthJson = { ...authJson, ...(options.authData || {}) };

  const launcherPath = deps.launcherMetadataPathForUser(options.currentUser);
  const launcherJson = deps.readJsonFile<any>(launcherPath, {});
  launcherJson.defaultTargetUser = options.targetUser;
  launcherJson.defaultInstallDir = options.installDir;
  launcherJson.updatedAt = new Date().toISOString();
  launcherJson.installedBy = options.currentUser;

  const { manifestPath, locatorManifestPath } = deps.reconcileInstallerManifest(
    {
      targetUser: options.targetUser,
      installDir: options.installDir,
      provider: options.provider,
      modelId: options.modelId,
      thinkingLevel: options.thinkingLevel,
      chatConfig: options.chatConfig || {},
      elevated: options.elevated,
    },
    deps,
  );

  writeInstallerJson(
    settingsPath,
    settingsJson,
    {
      elevated: options.elevated,
      ownerUser,
      ownerGroup,
    },
    deps,
  );
  writeInstallerJson(
    authPath,
    nextAuthJson,
    {
      elevated: options.elevated,
      ownerUser,
      ownerGroup,
    },
    deps,
  );
  deps.writeJsonFile(launcherPath, launcherJson);
  const launchers = deps.writeLaunchersForUser(
    options.currentUser,
    options.installDir,
  );

  return {
    settingsPath,
    authPath,
    launcherPath,
    manifestPath,
    locatorManifestPath,
    ...launchers,
  };
}
