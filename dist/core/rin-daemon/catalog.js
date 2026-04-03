import path from "node:path";
import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";
import { applyRuntimeProfileEnvironment, resolveRuntimeProfile, } from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
function resolveExtensionCommands(extensions = []) {
    const commands = [];
    const counts = new Map();
    for (const extension of extensions) {
        for (const command of extension?.commands?.values?.() ?? []) {
            const name = String(command?.name || "").trim();
            if (!name)
                continue;
            commands.push(command);
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    const seen = new Map();
    const takenInvocationNames = new Set();
    return commands.map((command) => {
        const name = String(command?.name || "").trim();
        const occurrence = (seen.get(name) ?? 0) + 1;
        seen.set(name, occurrence);
        let invocationName = (counts.get(name) ?? 0) > 1 ? `${name}:${occurrence}` : name;
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
async function createCatalogContext(options = {}) {
    const codingAgentModule = await loadRinCodingAgent();
    const { AuthStorage, DefaultResourceLoader, ModelRegistry, SettingsManager } = codingAgentModule;
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
    return { agentDir, authStorage, modelRegistry, resourceLoader };
}
export async function listCatalogCommands(options = {}) {
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
