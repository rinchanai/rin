import path from "node:path";
import { applyRuntimeProfileEnvironment, resolveRuntimeProfile, } from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
async function createCatalogContext(options = {}) {
    const codingAgentModule = await loadRinCodingAgent();
    const { AuthStorage, DefaultResourceLoader, ModelRegistry, SettingsManager, ExtensionRunner, createEventBus, discoverAndLoadExtensions, } = codingAgentModule;
    const { cwd, agentDir } = resolveRuntimeProfile({
        cwd: options.cwd,
        agentDir: options.agentDir,
    });
    applyRuntimeProfileEnvironment({ agentDir });
    if (process.cwd() !== cwd)
        process.chdir(cwd);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        additionalExtensionPaths: options.additionalExtensionPaths ?? [],
    });
    await resourceLoader.reload();
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
    const eventBus = createEventBus();
    const loadedExtensions = await discoverAndLoadExtensions(options.additionalExtensionPaths ?? [], cwd, agentDir, eventBus);
    const extensionRunner = new ExtensionRunner(loadedExtensions.extensions, loadedExtensions.runtime, cwd, null, modelRegistry);
    return {
        agentDir,
        authStorage,
        modelRegistry,
        resourceLoader,
        extensionRunner,
    };
}
export async function listCatalogCommands(options = {}) {
    const { resourceLoader, extensionRunner } = await createCatalogContext(options);
    const prompts = resourceLoader.getPrompts().prompts;
    const skills = resourceLoader.getSkills().skills;
    return [
        ...extensionRunner.getRegisteredCommands().map((command) => ({
            name: String(command?.invocationName || command?.name || "").trim(),
            description: String(command?.description || "").trim(),
            source: "extension",
            sourceInfo: command?.sourceInfo,
        })),
        ...prompts.map((template) => ({
            name: String(template?.name || "").trim(),
            description: String(template?.description || "").trim(),
            source: "prompt",
            sourceInfo: template?.sourceInfo,
        })),
        ...skills.map((skill) => ({
            name: `skill:${String(skill?.name || "").trim()}`,
            description: String(skill?.description || "").trim(),
            source: "skill",
            sourceInfo: skill?.sourceInfo,
        })),
    ].filter((item) => item.name);
}
export async function listCatalogModels(options = {}) {
    const { modelRegistry } = await createCatalogContext(options);
    return modelRegistry.getAvailable();
}
export async function getCatalogOAuthState(options = {}) {
    const { authStorage } = await createCatalogContext(options);
    const credentials = Object.fromEntries(authStorage.list().map((providerId) => {
        const credential = authStorage.get(providerId);
        return [providerId, credential ? { type: credential.type } : undefined];
    }));
    const providers = authStorage.getOAuthProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        usesCallbackServer: Boolean(provider.usesCallbackServer),
    }));
    return { credentials, providers };
}
