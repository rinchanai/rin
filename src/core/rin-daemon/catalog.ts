import path from "node:path";

import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { BuiltinModuleHost } from "../builtins/host.js";
import {
  dedupeSlashCommands,
  getBuiltinSlashCommands,
  getExtensionSlashCommands,
  getOAuthStateFromStorage,
  getPromptSlashCommands,
  getSkillSlashCommands,
} from "./catalog-helpers.js";

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
  const builtinHost = await BuiltinModuleHost.create({
    cwd,
    agentDir,
    modelRegistry,
  });

  return {
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    extensionRunner,
    builtinHost,
  };
}

export async function listCatalogCommands(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const { resourceLoader, extensionRunner, builtinHost } =
    await createCatalogContext(options);
  return dedupeSlashCommands([
    ...getBuiltinSlashCommands(),
    ...getExtensionSlashCommands(
      extensionRunner.getRegisteredCommands(),
      "extension",
    ),
    ...getExtensionSlashCommands(
      builtinHost.getRegisteredCommands(),
      "builtin_module",
    ),
    ...getPromptSlashCommands(resourceLoader.getPrompts().prompts),
    ...getSkillSlashCommands(resourceLoader.getSkills().skills),
  ]);
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
  return getOAuthStateFromStorage(authStorage);
}
