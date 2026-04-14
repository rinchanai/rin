import path from "node:path";

import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";

async function createCatalogContext(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const codingAgentModule = await loadRinCodingAgent();
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SettingsManager,
    ExtensionRunner,
    createEventBus,
    discoverAndLoadExtensions,
  } = codingAgentModule as any;

  const { cwd, agentDir } = resolveRuntimeProfile({
    cwd: options.cwd,
    agentDir: options.agentDir,
  });

  applyRuntimeProfileEnvironment({ agentDir });
  if (process.cwd() !== cwd) process.chdir(cwd);

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: options.additionalExtensionPaths ?? [],
  });
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
  );

  const eventBus = createEventBus();
  const loadedExtensions = await discoverAndLoadExtensions(
    options.additionalExtensionPaths ?? [],
    cwd,
    agentDir,
    eventBus,
  );
  const extensionRunner = new ExtensionRunner(
    loadedExtensions.extensions,
    loadedExtensions.runtime,
    cwd,
    null,
    modelRegistry,
  );

  return {
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    extensionRunner,
  };
}

export async function listCatalogCommands(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const { resourceLoader, extensionRunner } = await createCatalogContext(options);
  const prompts = resourceLoader.getPrompts().prompts;
  const skills = resourceLoader.getSkills().skills;
  return [
    ...BUILTIN_SLASH_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description,
      source: "builtin",
    })),
    ...extensionRunner.getRegisteredCommands().map((command: any) => ({
      name: String(command?.invocationName || command?.name || "").trim(),
      description: String(command?.description || "").trim(),
      source: "extension",
      sourceInfo: command?.sourceInfo,
    })),
    ...prompts.map((template: any) => ({
      name: String(template?.name || "").trim(),
      description: String(template?.description || "").trim(),
      source: "prompt",
      sourceInfo: template?.sourceInfo,
    })),
    ...skills.map((skill: any) => ({
      name: `skill:${String(skill?.name || "").trim()}`,
      description: String(skill?.description || "").trim(),
      source: "skill",
      sourceInfo: skill?.sourceInfo,
    })),
  ].filter((item) => item.name);
}

export async function listCatalogModels(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const { modelRegistry } = await createCatalogContext(options);
  return modelRegistry.getAvailable();
}

export async function getCatalogOAuthState(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const { authStorage } = await createCatalogContext(options);
  const credentials = Object.fromEntries(
    authStorage.list().map((providerId: string) => {
      const credential = authStorage.get(providerId);
      return [providerId, credential ? { type: credential.type } : undefined];
    }),
  );
  const providers = authStorage.getOAuthProviders().map((provider: any) => ({
    id: provider.id,
    name: provider.name,
    usesCallbackServer: Boolean(provider.usesCallbackServer),
  }));
  return { credentials, providers };
}
