import fs from "node:fs";
import path from "node:path";

import {
  defaultHomeForUser,
  installAuthPath,
  installerLocatorPathForHome,
  installerManifestPath,
  installerRecoveryManifestCandidates,
  installSettingsPath,
  legacyInstallerLocatorPathForHome,
  legacyInstallerManifestPath,
} from "./paths.js";

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
  const target = deps.findSystemUser(options.targetUser) as any;
  const ownerUser = target?.name || options.targetUser;
  const ownerGroup = target?.gid;
  const ownerHome = target?.home || defaultHomeForUser(ownerUser);
  if (!options.elevated) deps.ensureDir(options.installDir);

  const manifestPath = installerManifestPath(options.installDir);
  const legacyManifestPath = legacyInstallerManifestPath(options.installDir);
  const locatorManifestPath = installerLocatorPathForHome(ownerHome);
  const legacyLocatorManifestPath =
    legacyInstallerLocatorPathForHome(ownerHome);
  let manifestJson: any = {};
  for (const filePath of installerRecoveryManifestCandidates(
    options.installDir,
    ownerHome,
  )) {
    const current = deps.readInstallerJson<any>(
      filePath,
      null,
      Boolean(options.elevated),
    );
    if (current && typeof current === "object") {
      manifestJson = current;
      break;
    }
  }
  manifestJson.targetUser = options.targetUser;
  manifestJson.installDir = options.installDir;
  if (options.provider) manifestJson.defaultProvider = options.provider;
  if (options.modelId) manifestJson.defaultModel = options.modelId;
  if (options.thinkingLevel)
    manifestJson.defaultThinkingLevel = options.thinkingLevel;
  if (options.chatConfig) manifestJson.chat = options.chatConfig;
  if (manifestJson.koishi && typeof manifestJson.koishi === "object") {
    delete manifestJson.koishi;
  }
  manifestJson.updatedAt = new Date().toISOString();

  const manifestPaths = Array.from(
    new Set([manifestPath, locatorManifestPath]),
  );
  const legacyManifestPaths = Array.from(
    new Set([legacyManifestPath, legacyLocatorManifestPath]),
  );

  if (options.elevated) {
    for (const filePath of manifestPaths) {
      deps.writeJsonFileWithPrivilege(
        filePath,
        manifestJson,
        ownerUser,
        ownerGroup,
      );
    }
    for (const filePath of legacyManifestPaths) {
      try {
        deps.runPrivileged("rm", ["-f", filePath]);
      } catch {}
    }
  } else {
    for (const filePath of manifestPaths) {
      deps.writeJsonFile(filePath, manifestJson);
    }
    for (const filePath of legacyManifestPaths) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
    }
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
  const target = deps.findSystemUser(options.targetUser) as any;
  const ownerUser = target?.name || options.targetUser;
  const ownerGroup = target?.gid;
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = deps.readInstallerJson<any>(
    settingsPath,
    {},
    Boolean(options.elevated),
  );
  if (
    !settingsJson.chat &&
    settingsJson.koishi &&
    typeof settingsJson.koishi === "object"
  ) {
    settingsJson.chat = JSON.parse(JSON.stringify(settingsJson.koishi));
  }
  if (settingsJson.koishi && typeof settingsJson.koishi === "object") {
    delete settingsJson.koishi;
  }
  if (options.elevated) {
    deps.writeJsonFileWithPrivilege(
      settingsPath,
      settingsJson,
      ownerUser,
      ownerGroup,
    );
  } else {
    deps.writeJsonFile(settingsPath, settingsJson);
  }
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
  const target = deps.findSystemUser(options.targetUser) as any;
  const ownerUser = target?.name || options.targetUser;
  const ownerGroup = target?.gid;
  if (!options.elevated) deps.ensureDir(options.installDir);

  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = deps.readInstallerJson<any>(
    settingsPath,
    {},
    Boolean(options.elevated),
  );
  if (options.provider) settingsJson.defaultProvider = options.provider;
  if (options.modelId) settingsJson.defaultModel = options.modelId;
  if (options.thinkingLevel)
    settingsJson.defaultThinkingLevel = options.thinkingLevel;
  if (
    !settingsJson.chat &&
    settingsJson.koishi &&
    typeof settingsJson.koishi === "object"
  ) {
    settingsJson.chat = JSON.parse(JSON.stringify(settingsJson.koishi));
  }
  if (options.chatConfig && typeof options.chatConfig === "object") {
    settingsJson.chat ||= {};
    for (const [adapterKey, adapterConfig] of Object.entries(
      options.chatConfig,
    )) {
      if (adapterConfig === undefined) continue;
      settingsJson.chat[adapterKey] = adapterConfig;
    }
  }
  if (settingsJson.koishi && typeof settingsJson.koishi === "object") {
    delete settingsJson.koishi;
  }

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

  if (options.elevated) {
    deps.writeJsonFileWithPrivilege(
      settingsPath,
      settingsJson,
      ownerUser,
      ownerGroup,
    );
    deps.writeJsonFileWithPrivilege(
      authPath,
      nextAuthJson,
      ownerUser,
      ownerGroup,
    );
  } else {
    deps.writeJsonFile(settingsPath, settingsJson);
    deps.writeJsonFile(authPath, nextAuthJson);
  }
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
