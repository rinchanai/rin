import path from "node:path";

import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";

function resolveExtensionCommands(extensions: any[] = []) {
  const commands: any[] = [];
  const counts = new Map<string, number>();
  for (const extension of extensions) {
    for (const command of extension?.commands?.values?.() ?? []) {
      const name = String(command?.name || "").trim();
      if (!name) continue;
      commands.push(command);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const seen = new Map<string, number>();
  const takenInvocationNames = new Set<string>();
  return commands.map((command) => {
    const name = String(command?.name || "").trim();
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    let invocationName =
      (counts.get(name) ?? 0) > 1 ? `${name}:${occurrence}` : name;
    if (takenInvocationNames.has(invocationName)) {
      let suffix = occurrence;
      do {
        suffix += 1;
        invocationName = `${name}:${suffix}`;
      } while (takenInvocationNames.has(invocationName));
    }
    takenInvocationNames.add(invocationName);
    return {
      name: invocationName,
      description: String(command?.description || "").trim(),
      source: "extension",
      sourceInfo: command?.sourceInfo,
    };
  });
}

async function createCatalogContext(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const codingAgentModule = await loadRinCodingAgent();
  const { AuthStorage, DefaultResourceLoader, ModelRegistry, SettingsManager } =
    codingAgentModule as any;

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

  return { agentDir, authStorage, modelRegistry, resourceLoader };
}

export async function listCatalogCommands(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const { resourceLoader } = await createCatalogContext(options);
  const extensions = resourceLoader.getExtensions().extensions;
  const prompts = resourceLoader.getPrompts().prompts;
  const skills = resourceLoader.getSkills().skills;
  return [
    ...BUILTIN_SLASH_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description,
      source: "builtin",
    })),
    ...resolveExtensionCommands(extensions),
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
