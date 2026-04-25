import path from "node:path";

import { promptChatBridgeSetup } from "../chat-bridge/setup.js";
import {
  defaultInstallDirForHome,
  installAuthPath,
  installSettingsPath,
  installerManifestPath,
  legacyInstallerManifestPath,
} from "./paths.js";
import {
  configureProviderAuth,
  computeAvailableThinkingLevels,
  loadModelChoices,
} from "./provider-auth.js";
import { createInstallerI18n, type InstallerI18n } from "./i18n.js";

export type PromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
  confirm: (options: any) => Promise<any>;
};

export type SystemUser = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

export async function promptTargetInstall(
  prompt: PromptApi,
  currentUser: string,
  allUsers: SystemUser[],
  targetHomeForUser: (user: string) => string,
  i18n: InstallerI18n = createInstallerI18n(),
) {
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser);
  const existingCandidates = otherUsers.length
    ? otherUsers
    : allUsers.filter((entry) => entry.name !== currentUser).length
      ? allUsers.filter((entry) => entry.name !== currentUser)
      : allUsers;

  const targetMode = prompt.ensureNotCancelled(
    await prompt.select({
      message: i18n.chooseTargetUserMessage,
      options: [
        {
          value: "current",
          label: i18n.currentUserLabel,
          hint: currentUser,
        },
        {
          value: "existing",
          label: i18n.existingOtherUserLabel,
          hint: existingCandidates.length
            ? i18n.usersHint(existingCandidates.length)
            : i18n.noneFoundHint,
        },
        { value: "new", label: i18n.newUserLabel, hint: i18n.newUserHint },
      ],
    }),
  );

  let targetUser = currentUser;
  if (targetMode === "existing") {
    if (!existingCandidates.length) {
      return {
        cancelled: true as const,
        targetUser,
        existingCandidates,
        allUsers,
      };
    }
    targetUser = prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseExistingUserMessage,
        options: existingCandidates.map((entry) => ({
          value: entry.name,
          label: entry.name,
          hint: `${entry.home} · uid ${entry.uid}`,
        })),
      }),
    );
  } else if (targetMode === "new") {
    targetUser = prompt.ensureNotCancelled(
      await prompt.text({
        message: i18n.enterNewUsernameMessage,
        placeholder: i18n.usernamePlaceholder,
        validate(value: string) {
          const next = String(value || "").trim();
          if (!next) return i18n.usernameRequired;
          if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next))
            return i18n.usernameInvalid;
        },
      }),
    );
  }

  const defaultDir = defaultInstallDirForHome(targetHomeForUser(targetUser));
  const installDir = String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: i18n.chooseInstallDirMessage,
        placeholder: defaultDir,
        defaultValue: defaultDir,
        validate(value: string) {
          const next = String(value || "").trim();
          if (!next) return i18n.directoryRequired;
          if (!path.isAbsolute(next)) return i18n.directoryMustBeAbsolute;
        },
      }),
    ),
  ).trim();

  return {
    cancelled: false as const,
    targetUser,
    installDir,
    defaultDir,
    existingCandidates,
    allUsers,
  };
}

export function describeInstallDirState(
  installDir: string,
  state: { exists: boolean; entryCount: number; sample: string[] },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  if (state.exists) {
    return {
      title: i18n.existingDirectoryTitle,
      text: i18n.existingDirectoryText(
        installDir,
        state.entryCount,
        state.sample,
      ),
    };
  }
  return {
    title: i18n.installDirectoryTitle,
    text: i18n.newDirectoryText(installDir),
  };
}

export async function promptDefaultTargetUser(
  prompt: PromptApi,
  targetUser: string,
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return Boolean(
    prompt.ensureNotCancelled(
      await prompt.confirm({
        message: i18n.chooseDefaultTargetMessage(targetUser),
        initialValue: true,
      }),
    ),
  );
}

function normalizeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function loadExistingProviderDefaults(
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
) {
  const candidates = [
    installSettingsPath(installDir),
    installerManifestPath(installDir),
    legacyInstallerManifestPath(installDir),
  ];
  for (const filePath of candidates) {
    const record = normalizeRecord(readJsonFile<any>(filePath, {}));
    const provider = String(record.defaultProvider || "").trim();
    const modelId = String(record.defaultModel || "").trim();
    const thinkingLevel = String(record.defaultThinkingLevel || "").trim();
    if (provider && modelId && thinkingLevel) {
      return { provider, modelId, thinkingLevel };
    }
  }
  return null;
}

function hasStoredProviderAuth(authData: unknown, provider: string) {
  const record = normalizeRecord(authData);
  return Object.prototype.hasOwnProperty.call(record, provider);
}

export async function promptProviderSetup(
  prompt: PromptApi,
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
  deps: {
    loadModelChoices?: typeof loadModelChoices;
    configureProviderAuth?: typeof configureProviderAuth;
  } = {},
  i18n: InstallerI18n = createInstallerI18n(),
) {
  let provider = "";
  let modelId = "";
  let thinkingLevel = "";
  let authResult: any = { available: false, authKind: "pending", authData: {} };

  const loadChoices = deps.loadModelChoices || loadModelChoices;
  const configureAuth = deps.configureProviderAuth || configureProviderAuth;
  const models = await loadChoices(installDir, readJsonFile);
  const providerNames = [
    ...new Set(models.map((model) => model.provider).filter(Boolean)),
  ];
  if (!providerNames.length) throw new Error(i18n.noModelsAvailableError);

  const existingDefaults = loadExistingProviderDefaults(
    installDir,
    readJsonFile,
  );
  const existingAuthData = normalizeRecord(
    readJsonFile<any>(installAuthPath(installDir), {}),
  );
  if (
    existingDefaults &&
    hasStoredProviderAuth(existingAuthData, existingDefaults.provider)
  ) {
    const existingModel = models.find(
      (model) =>
        model.provider === existingDefaults.provider &&
        model.id === existingDefaults.modelId,
    );
    if (
      existingModel &&
      computeAvailableThinkingLevels(existingModel).includes(
        existingDefaults.thinkingLevel as any,
      )
    ) {
      return {
        ...existingDefaults,
        authResult: {
          available: true,
          authKind: "existing",
          authData: existingAuthData,
        },
      };
    }
  }

  provider = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseProviderMessage,
        options: providerNames.map((name) => {
          const scoped = models.filter((model) => model.provider === name);
          const availableCount = scoped.filter(
            (model) => model.available,
          ).length;
          return {
            value: name,
            label: name,
            hint: availableCount
              ? `${availableCount}/${scoped.length} ${i18n.providerReadyHint}`
              : `${scoped.length} models`,
          };
        }),
      }),
    ),
  );

  authResult = await configureAuth(String(provider), installDir, {
    readJsonFile,
    ensureNotCancelled: prompt.ensureNotCancelled,
    i18n,
  });

  const providerModels = models.filter((model) => model.provider === provider);
  if (!providerModels.length)
    throw new Error(i18n.noModelsForProviderError(provider));
  modelId = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseModelMessage,
        options: providerModels.map((model) => ({
          value: model.id,
          label: model.id,
          hint: [
            authResult.available || model.available
              ? i18n.providerReadyHint
              : i18n.providerNeedsAuthHint,
            model.reasoning ? i18n.reasoningHint : i18n.noReasoningHint,
          ].join(" · "),
        })),
      }),
    ),
  );

  const model = providerModels.find((entry) => entry.id === modelId)!;
  thinkingLevel = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseThinkingLevelMessage,
        options: computeAvailableThinkingLevels(model).map((level) => ({
          value: level,
          label: level,
        })),
      }),
    ),
  );

  return { provider, modelId, thinkingLevel, authResult };
}

export async function promptChatSetup(
  prompt: PromptApi,
  i18n: InstallerI18n = createInstallerI18n(),
) {
  const result = await promptChatBridgeSetup(prompt, {}, i18n);
  return {
    chatDescription: result.chatDescription,
    chatDetail: result.chatDetail,
    chatConfig: result.chatConfig,
  };
}

export function buildInstallSafetyBoundaryText(
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildInstallSafetyBoundaryText();
}

export function buildInstallPlanText(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    authAvailable: boolean;
    chatDescription: string;
    chatDetail: string;
    language?: string;
    setDefaultTarget?: boolean;
  },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildInstallPlanText({
    targetUser: options.targetUser,
    installDir: options.installDir,
    provider: options.provider,
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel,
    authAvailable: options.authAvailable,
    chatDescription: options.chatDescription,
    chatDetail: options.chatDetail,
    language: String(options.language || i18n.language || "en"),
    setDefaultTarget: options.setDefaultTarget !== false,
  });
}

export function buildPlainInstallerSection(title: string, body: string) {
  const header = String(title || "").trim();
  const lines = String(body || "").split("\n");
  return [header, ...lines.map((line) => (line ? `  ${line}` : ""))]
    .filter((line, index) => index === 0 || line !== "")
    .join("\n");
}

export function buildPostInstallInitExitText(
  options: {
    currentUser: string;
    targetUser: string;
  },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildPostInstallInitExitText(options);
}

export function buildFinalRequirements(
  options: {
    installServiceNow: boolean;
    needsElevatedWrite: boolean;
    needsElevatedService: boolean;
  },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildFinalRequirements(options);
}
