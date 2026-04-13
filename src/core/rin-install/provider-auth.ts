import path from "node:path";

import { spinner, text } from "@clack/prompts";

import { loadRinCodingAgent } from "../rin-lib/loader.js";

export function computeAvailableThinkingLevels(model: {
  provider: string;
  id: string;
  reasoning: boolean;
}) {
  if (!model.reasoning) return ["off"];
  const id = String(model.id || "").toLowerCase();
  const provider = String(model.provider || "").toLowerCase();
  return provider === "openai" && id.includes("codex-max")
    ? ["off", "minimal", "low", "medium", "high", "xhigh"]
    : ["off", "minimal", "low", "medium", "high"];
}

export async function loadModelChoices() {
  const { getProviders, getModels } = await import("@mariozechner/pi-ai");
  const merged = new Map<
    string,
    { provider: string; id: string; reasoning: boolean; available: boolean }
  >();

  for (const provider of getProviders()) {
    for (const model of getModels(provider as any)) {
      merged.set(
        `${(model as any).provider || provider}/${(model as any).id || ""}`,
        {
          provider: String((model as any).provider || provider),
          id: String((model as any).id || ""),
          reasoning: Boolean((model as any).reasoning),
          available: false,
        },
      );
    }
  }

  const choices = [...merged.values()].filter(
    (model) => model.provider && model.id,
  );
  choices.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
  return choices;
}

export async function createInstallerAuthStorage(
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
  deps: {
    loadRinCodingAgent?: typeof loadRinCodingAgent;
  } = {},
) {
  const loadCodingAgent = deps.loadRinCodingAgent ?? loadRinCodingAgent;
  const codingAgentModule = await loadCodingAgent();
  const { AuthStorage } = codingAgentModule as any;
  const authPath = path.join(installDir, "auth.json");
  const existing = readJsonFile<any>(authPath, {});
  return AuthStorage.inMemory(existing);
}

export async function configureProviderAuth(
  provider: string,
  installDir: string,
  deps: {
    readJsonFile: <T>(filePath: string, fallback: T) => T;
    ensureNotCancelled: <T>(value: T | symbol) => T;
    createInstallerAuthStorage?: typeof createInstallerAuthStorage;
    spinner?: typeof spinner;
    text?: typeof text;
    timeoutSignal?: (ms: number) => AbortSignal;
  },
) {
  const buildAuthStorage =
    deps.createInstallerAuthStorage ?? createInstallerAuthStorage;
  const createSpinner = deps.spinner ?? spinner;
  const promptText = deps.text ?? text;
  const timeoutSignal =
    deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const authStorage = await buildAuthStorage(installDir, deps.readJsonFile);
  if (authStorage.hasAuth?.(provider)) {
    return {
      available: true,
      authKind: "existing",
      authData: authStorage.getAll?.() || {},
    };
  }

  const oauthProviders = Array.isArray(authStorage.getOAuthProviders?.())
    ? authStorage.getOAuthProviders()
    : [];
  const oauthProvider = oauthProviders.find(
    (entry: any) => entry.id === provider,
  );

  if (oauthProvider) {
    const loginSpinner = createSpinner();
    let lastAuthUrl = "";
    loginSpinner.start(`Starting ${oauthProvider.name || provider} login...`);
    try {
      await authStorage.login(provider, {
        onAuth(info: { url: string; instructions?: string }) {
          lastAuthUrl = String(info?.url || "");
          loginSpinner.stop(
            `Open this URL to continue login:\n${lastAuthUrl}${info?.instructions ? `\n${info.instructions}` : ""}`,
          );
        },
        async onPrompt(prompt: { message: string; placeholder?: string }) {
          return String(
            deps.ensureNotCancelled(
              await promptText({
                message: prompt.message || "Enter login value.",
                placeholder: prompt.placeholder,
                validate(value) {
                  if (!String(value || "").trim())
                    return "A value is required.";
                },
              }),
            ),
          ).trim();
        },
        onProgress(message: string) {
          loginSpinner.message(
            message || `Waiting for ${oauthProvider.name || provider} login...`,
          );
        },
        async onManualCodeInput() {
          return String(
            deps.ensureNotCancelled(
              await promptText({
                message: "Paste the redirect URL or code from the browser.",
                placeholder: lastAuthUrl
                  ? "paste the final redirect URL or device code"
                  : "paste the code",
                validate(value) {
                  if (!String(value || "").trim())
                    return "A value is required.";
                },
              }),
            ),
          ).trim();
        },
        signal: timeoutSignal(10 * 60 * 1000),
      });
      loginSpinner.stop(`${oauthProvider.name || provider} login complete.`);
      return {
        available: true,
        authKind: "oauth",
        authData: authStorage.getAll?.() || {},
      };
    } catch (error: any) {
      loginSpinner.stop(`Login failed for ${oauthProvider.name || provider}.`);
      throw error;
    }
  }

  const token = String(
    deps.ensureNotCancelled(
      await promptText({
        message: `Enter the API key or token for ${provider}.`,
        placeholder: "token",
        validate(value) {
          if (!String(value || "").trim()) return "A token is required.";
        },
      }),
    ),
  ).trim();
  authStorage.set(provider, { type: "api_key", key: token });
  return {
    available: true,
    authKind: "api_key",
    authData: authStorage.getAll?.() || {},
  };
}
