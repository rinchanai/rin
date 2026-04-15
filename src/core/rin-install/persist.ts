import fs from "node:fs";
import path from "node:path";

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
  if (!options.elevated) deps.ensureDir(options.installDir);

  const manifestPath = path.join(options.installDir, "installer.json");
  const legacyManifestPath = path.join(
    options.installDir,
    "config",
    "installer.json",
  );
  const manifestJson = deps.readInstallerJson<any>(
    manifestPath,
    deps.readInstallerJson<any>(
      legacyManifestPath,
      {},
      Boolean(options.elevated),
    ),
    Boolean(options.elevated),
  );
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

  if (options.elevated) {
    deps.writeJsonFileWithPrivilege(
      manifestPath,
      manifestJson,
      ownerUser,
      ownerGroup,
    );
    try {
      deps.runPrivileged("rm", ["-f", legacyManifestPath]);
    } catch {}
  } else {
    deps.writeJsonFile(manifestPath, manifestJson);
    try {
      fs.rmSync(legacyManifestPath, { force: true });
    } catch {}
  }

  return { manifestPath, legacyManifestPath };
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
    appConfigDirForUser: (userName: string) => string;
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

  const settingsPath = path.join(options.installDir, "settings.json");
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

  const authPath = path.join(options.installDir, "auth.json");
  const authJson = deps.readInstallerJson<any>(
    authPath,
    {},
    Boolean(options.elevated),
  );
  const nextAuthJson = { ...authJson, ...(options.authData || {}) };

  const launcherPath = path.join(
    deps.appConfigDirForUser(options.currentUser),
    "install.json",
  );
  const launcherJson = deps.readJsonFile<any>(launcherPath, {});
  launcherJson.defaultTargetUser = options.targetUser;
  launcherJson.defaultInstallDir = options.installDir;
  launcherJson.updatedAt = new Date().toISOString();
  launcherJson.installedBy = options.currentUser;

  const { manifestPath } = deps.reconcileInstallerManifest(
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

  return { settingsPath, authPath, launcherPath, manifestPath, ...launchers };
}
