import os from "node:os";
import { spawn } from "node:child_process";

import { escapeHtml } from "../rin-gui/web-assets.js";
import { releaseInfoFromEnv } from "../rin-lib/release.js";
import {
  buildFinalizeInstallPlanCommand,
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
  writeFinalizeInstallPlanFile,
} from "./apply-plan.js";
import { detectCurrentUser } from "./common.js";
import { readJsonFile, writeJsonFile } from "./fs-utils.js";
import {
  buildFinalRequirements,
  buildInstallPlanText,
  buildInstallSafetyBoundaryText,
} from "./interactive.js";
import { createInstallerI18n } from "./i18n.js";
import { defaultInstallDirForHome, installAuthPath } from "./paths.js";
import {
  computeAvailableThinkingLevels,
  loadModelChoices,
} from "./provider-auth.js";
import {
  describeOwnership,
  shouldUseElevatedWrite,
  targetHomeForUser,
} from "./users.js";

export type GuiInstallerOptions = Record<string, never>;

export type GuiInstallerPlanInput = {
  language?: string;
  currentUser?: string;
  targetUser?: string;
  installDir?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  authAvailable?: boolean;
  setDefaultTarget?: boolean;
};

export type GuiInstallerModelChoice = {
  provider: string;
  id: string;
  reasoning: boolean;
  available: boolean;
  thinkingLevels: string[];
};

export type GuiInstallerFinalizePlan = {
  options: FinalizeInstallOptions;
  needsElevatedWrite: boolean;
  needsElevatedService: boolean;
  finalRequirements: string[];
};

export type GuiInstallerHostLaunch = {
  command: string;
  args: string[];
};

const DEFAULT_INSTALLER_DESKTOP_HOST = "rin-desktop-host";

function splitHostCommand(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function buildGuiInstallerHostLaunch(
  env: NodeJS.ProcessEnv = process.env,
): GuiInstallerHostLaunch {
  const parts = splitHostCommand(
    env.RIN_INSTALLER_GUI_HOST ||
      env.RIN_GUI_NATIVE_HOST ||
      DEFAULT_INSTALLER_DESKTOP_HOST,
  );
  const command = parts.shift() || DEFAULT_INSTALLER_DESKTOP_HOST;
  return { command, args: [...parts, "--stdio", "--installer"] };
}

export function shouldStartGuiInstaller(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  const args = argv.map((arg) => String(arg || "").trim()).filter(Boolean);
  if (String(env.RIN_INSTALL_APPLY_PLAN || "").trim()) return false;
  if (
    String(env.RIN_INSTALL_MODE || "")
      .trim()
      .toLowerCase() === "update"
  )
    return false;
  if (args.includes("--tui") || args.includes("--no-gui")) return false;
  if (args.includes("--gui")) return true;
  return platform === "win32";
}

export function parseGuiInstallerArgs(argv: string[]): GuiInstallerOptions {
  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg || arg === "--gui") continue;
    if (arg === "--") break;
    throw new Error(`rin_installer_gui_unrecognized_arg:${arg}`);
  }
  return {};
}

function sendHostEvent(stdin: NodeJS.WritableStream, payload: unknown) {
  stdin.write(`${JSON.stringify(payload)}\n`);
}

export function normalizeGuiInstallerModelChoices(
  models: Array<{
    provider?: string;
    id?: string;
    reasoning?: boolean;
    available?: boolean;
  }>,
): GuiInstallerModelChoice[] {
  return models
    .map((model) => ({
      provider: String(model.provider || "").trim(),
      id: String(model.id || "").trim(),
      reasoning: Boolean(model.reasoning),
      available: Boolean(model.available),
      thinkingLevels: computeAvailableThinkingLevels(model as any),
    }))
    .filter((model) => model.provider && model.id)
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
}

export async function buildGuiInstallerModelChoices(installDir = "") {
  return normalizeGuiInstallerModelChoices(
    await loadModelChoices(installDir, readJsonFile),
  );
}

function normalizeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function assertSelectedProviderModel(
  plan: ReturnType<typeof buildGuiInstallerPlan>,
) {
  if (!plan.provider || plan.provider === "pending") {
    throw new Error("rin_installer_gui_provider_required");
  }
  if (!plan.modelId || plan.modelId === "pending") {
    throw new Error("rin_installer_gui_model_required");
  }
}

export function saveGuiInstallerApiKeyAuth(
  input: { installDir?: string; provider?: string; token?: string },
  deps: {
    readJsonFile?: typeof readJsonFile;
    writeJsonFile?: typeof writeJsonFile;
  } = {},
) {
  const installDir = String(input.installDir || "").trim();
  const provider = String(input.provider || "").trim();
  const token = String(input.token || "").trim();
  if (!installDir) throw new Error("rin_installer_gui_install_dir_required");
  if (!provider || provider === "pending") {
    throw new Error("rin_installer_gui_provider_required");
  }
  if (!token) throw new Error("rin_installer_gui_token_required");

  const authPath = installAuthPath(installDir);
  const readAuthJson = deps.readJsonFile || readJsonFile;
  const writeAuthJson = deps.writeJsonFile || writeJsonFile;
  const authData = normalizeRecord(readAuthJson<any>(authPath, {}));
  const nextAuthData = {
    ...authData,
    [provider]: { type: "api_key", key: token },
  };
  writeAuthJson(authPath, nextAuthData);
  return { provider, authPath, available: true };
}

export function buildGuiInstallerPlan(input: GuiInstallerPlanInput = {}) {
  const language = String(input.language || "en").trim() || "en";
  const i18n = createInstallerI18n(language);
  const currentUser = String(input.currentUser || detectCurrentUser()).trim();
  const targetUser =
    String(input.targetUser || currentUser).trim() || currentUser;
  const installDir =
    String(input.installDir || "").trim() ||
    defaultInstallDirForHome(targetHomeForUser(targetUser) || os.homedir());
  const provider = String(input.provider || "pending").trim() || "pending";
  const modelId = String(input.modelId || "pending").trim() || "pending";
  const thinkingLevel =
    String(input.thinkingLevel || "medium").trim() || "medium";
  const authAvailable = Boolean(input.authAvailable);
  const setDefaultTarget = input.setDefaultTarget !== false;
  const planText = buildInstallPlanText(
    {
      currentUser,
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      authAvailable,
      chatDescription: i18n.chatDisabledDescription,
      chatDetail: "",
      language,
      setDefaultTarget,
    },
    i18n,
  );
  return {
    language: i18n.language,
    currentUser,
    targetUser,
    installDir,
    provider,
    modelId,
    thinkingLevel,
    authAvailable,
    setDefaultTarget,
    safety: buildInstallSafetyBoundaryText(i18n),
    planText,
  };
}

export function buildGuiInstallerFinalizePlan(
  input: GuiInstallerPlanInput = {},
  deps: {
    readJsonFile?: typeof readJsonFile;
    releaseInfoFromEnv?: typeof releaseInfoFromEnv;
    describeOwnership?: typeof describeOwnership;
    shouldUseElevatedWrite?: typeof shouldUseElevatedWrite;
    platform?: NodeJS.Platform;
  } = {},
): GuiInstallerFinalizePlan {
  const plan = buildGuiInstallerPlan(input);
  assertSelectedProviderModel(plan);
  const readAuthJson = deps.readJsonFile || readJsonFile;
  const authData = normalizeRecord(
    readAuthJson<any>(installAuthPath(plan.installDir), {}),
  );
  if (!Object.prototype.hasOwnProperty.call(authData, plan.provider)) {
    throw new Error(
      `rin_installer_gui_provider_auth_required:${plan.provider}`,
    );
  }
  const i18n = createInstallerI18n(plan.language);
  const ownership = (deps.describeOwnership || describeOwnership)(
    plan.targetUser,
    plan.installDir,
  );
  const platform = deps.platform || process.platform;
  const installServiceNow = ["darwin", "linux", "win32"].includes(platform);
  const needsElevatedWrite = (
    deps.shouldUseElevatedWrite || shouldUseElevatedWrite
  )(plan.targetUser, ownership);
  const needsElevatedService =
    installServiceNow && plan.targetUser !== plan.currentUser;
  return {
    options: {
      currentUser: plan.currentUser,
      targetUser: plan.targetUser,
      installDir: plan.installDir,
      provider: plan.provider,
      modelId: plan.modelId,
      thinkingLevel: plan.thinkingLevel,
      language: plan.language,
      setDefaultTarget: plan.setDefaultTarget,
      chatDescription: i18n.chatDisabledDescription,
      chatDetail: "",
      chatConfig: null,
      authData,
      release: (deps.releaseInfoFromEnv || releaseInfoFromEnv)(),
    },
    needsElevatedWrite,
    needsElevatedService,
    finalRequirements: buildFinalRequirements(
      { installServiceNow, needsElevatedWrite, needsElevatedService },
      i18n,
    ),
  };
}

export function buildGuiInstallerHtml() {
  const initialPlan = buildGuiInstallerPlan();
  const title = "Rin Installer";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; }
    h1 { margin-top: 0; }
    form { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    label { display: grid; gap: 6px; font-weight: 600; }
    input, select, button { border-radius: 8px; padding: 10px; font: inherit; }
    button { cursor: pointer; }
    .wide { grid-column: 1 / -1; }
    pre { white-space: pre-wrap; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: 12px; overflow: auto; }
    .notice { padding: 12px; border-radius: 10px; background: color-mix(in srgb, Highlight 12%, Canvas); }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="notice">This GUI-first installer runs in the packaged Rin desktop host. It does not expose a browser server or browser fallback.</p>
    <form id="installer-form">
      <label>Language
        <select name="language">
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
      </label>
      <label>Target user
        <input name="targetUser" value="${escapeHtml(initialPlan.targetUser)}" />
      </label>
      <label class="wide">Install directory
        <input name="installDir" value="${escapeHtml(initialPlan.installDir)}" />
      </label>
      <label>Provider
        <select name="provider"><option value="pending">Loading providers…</option></select>
      </label>
      <label>Model
        <select name="modelId"><option value="pending">Select a provider first</option></select>
      </label>
      <label>Thinking level
        <select name="thinkingLevel"><option value="medium">medium</option></select>
      </label>
      <p id="model-status" class="notice wide">Loading local model and provider auth state…</p>
      <label class="wide">API key / manual token for selected provider
        <input name="apiKey" type="password" autocomplete="off" placeholder="Leave blank when existing auth is ready" />
      </label>
      <button id="save-auth-button" class="wide" type="button">Save provider auth</button>
      <p id="auth-status" class="notice wide">Use this only in the local desktop installer; tokens are saved to the selected install directory.</p>
      <label class="wide"><input name="setDefaultTarget" type="checkbox" checked /> Set as the default target for this launcher user</label>
      <button class="wide" type="submit">Refresh plan</button>
      <button id="apply-button" class="wide" type="button">Apply installation</button>
      <p id="apply-status" class="notice wide">Review the plan, then apply when provider auth is ready.</p>
    </form>
    <h2>Safety boundary</h2>
    <pre id="safety">${escapeHtml(initialPlan.safety)}</pre>
    <h2>Install plan</h2>
    <pre id="plan">${escapeHtml(initialPlan.planText)}</pre>
  </main>
  <script>
    const form = document.getElementById('installer-form');
    const safety = document.getElementById('safety');
    const plan = document.getElementById('plan');
    const providerSelect = form.elements.provider;
    const modelSelect = form.elements.modelId;
    const thinkingSelect = form.elements.thinkingLevel;
    const modelStatus = document.getElementById('model-status');
    const applyButton = document.getElementById('apply-button');
    const applyStatus = document.getElementById('apply-status');
    const saveAuthButton = document.getElementById('save-auth-button');
    const authStatus = document.getElementById('auth-status');
    let modelChoices = [];

    function send(command) { window.rinDesktop.send(command); }

    function setOptions(select, values, selected) {
      select.replaceChildren(...values.map((value) => {
        const option = document.createElement('option');
        option.value = value.value;
        option.textContent = value.label;
        if (value.value === selected) option.selected = true;
        return option;
      }));
    }

    function selectedModel() {
      return modelChoices.find((model) => model.provider === providerSelect.value && model.id === modelSelect.value);
    }

    function refreshModelFields() {
      const provider = providerSelect.value;
      const models = modelChoices.filter((model) => model.provider === provider);
      setOptions(modelSelect, models.length ? models.map((model) => ({ value: model.id, label: model.available ? model.id + ' · auth ready' : model.id + ' · auth needed' })) : [{ value: 'pending', label: 'No models found for this provider' }], modelSelect.value);
      const model = selectedModel() || models[0];
      if (model) modelSelect.value = model.id;
      const levels = (model && model.thinkingLevels.length ? model.thinkingLevels : ['medium']).map((level) => ({ value: level, label: level }));
      setOptions(thinkingSelect, levels, thinkingSelect.value || 'medium');
      modelStatus.textContent = model ? (model.available ? 'Provider auth already exists for the selected model.' : 'Provider auth is still required before final install.') : 'No local models are available yet.';
    }

    function loadModels() {
      const data = new FormData(form);
      send({ type: 'installer:models', installDir: String(data.get('installDir') || '') });
    }

    function installerPayload() {
      const data = new FormData(form);
      const model = selectedModel();
      return {
        language: data.get('language'),
        targetUser: data.get('targetUser'),
        installDir: data.get('installDir'),
        provider: data.get('provider'),
        modelId: data.get('modelId'),
        thinkingLevel: data.get('thinkingLevel'),
        authAvailable: Boolean(model && model.available),
        setDefaultTarget: data.get('setDefaultTarget') === 'on',
      };
    }

    function refreshPlan(event) {
      if (event) event.preventDefault();
      send({ type: 'installer:plan', input: installerPayload() });
    }

    function saveProviderAuth() {
      saveAuthButton.disabled = true;
      authStatus.textContent = 'Saving provider auth…';
      const data = new FormData(form);
      send({
        type: 'installer:auth:api-key',
        input: {
          installDir: data.get('installDir'),
          provider: data.get('provider'),
          token: data.get('apiKey'),
        },
      });
    }

    function applyInstallation() {
      applyButton.disabled = true;
      applyStatus.textContent = 'Applying installation… keep this desktop window open.';
      send({ type: 'installer:apply', input: installerPayload() });
    }

    window.rinDesktop.onEvent((payload) => {
      if (payload.type === 'installer:models') {
        modelChoices = payload.models || [];
        const providers = [...new Set(modelChoices.map((model) => model.provider))];
        setOptions(providerSelect, providers.length ? providers.map((provider) => ({ value: provider, label: provider })) : [{ value: 'pending', label: 'No providers found' }], providerSelect.value);
        refreshModelFields();
        refreshPlan();
      } else if (payload.type === 'installer:plan') {
        safety.textContent = payload.plan && payload.plan.safety || '';
        plan.textContent = payload.plan && payload.plan.planText || payload.error || '';
      } else if (payload.type === 'installer:auth:api-key') {
        saveAuthButton.disabled = false;
        if (payload.ok) {
          form.elements.apiKey.value = '';
          authStatus.textContent = 'Provider auth saved for ' + payload.provider + '.';
          loadModels();
        } else {
          authStatus.textContent = payload.error || 'rin_installer_gui_auth_failed';
        }
      } else if (payload.type === 'installer:apply') {
        applyButton.disabled = false;
        if (payload.ok) {
          applyStatus.textContent = 'Installation applied. Settings: ' + (payload.result && payload.result.written && payload.result.written.settingsPath || 'written');
        } else if (payload.terminalCommand) {
          applyStatus.textContent = 'Terminal confirmation required. Run this command in the launch terminal: ' + payload.terminalCommand;
        } else {
          applyStatus.textContent = payload.error || 'rin_installer_gui_apply_failed';
        }
      } else if (payload.type === 'installer:error') {
        modelStatus.textContent = payload.error || 'rin_installer_gui_error';
      }
    });

    form.elements.installDir.addEventListener('change', () => { loadModels(); });
    providerSelect.addEventListener('change', () => { refreshModelFields(); refreshPlan(); });
    modelSelect.addEventListener('change', () => { refreshModelFields(); refreshPlan(); });
    thinkingSelect.addEventListener('change', () => { refreshPlan(); });
    saveAuthButton.addEventListener('click', () => { saveProviderAuth(); });
    applyButton.addEventListener('click', () => { applyInstallation(); });
    form.addEventListener('submit', refreshPlan);
    loadModels();
  </script>
</body>
</html>`;
}

async function handleGuiInstallerCommand(command: any) {
  if (command?.type === "installer:models") {
    return {
      type: "installer:models",
      models: await buildGuiInstallerModelChoices(
        String(command.installDir || ""),
      ),
    };
  }
  if (command?.type === "installer:plan") {
    return {
      type: "installer:plan",
      plan: buildGuiInstallerPlan(command.input || {}),
    };
  }
  if (command?.type === "installer:auth:api-key") {
    const result = saveGuiInstallerApiKeyAuth(command.input || {});
    return { type: "installer:auth:api-key", ok: true, ...result };
  }
  if (command?.type === "installer:apply") {
    const finalPlan = buildGuiInstallerFinalizePlan(command.input || {});
    if (finalPlan.needsElevatedWrite || finalPlan.needsElevatedService) {
      const planPath = writeFinalizeInstallPlanFile(finalPlan.options);
      return {
        type: "installer:apply",
        ok: false,
        error: "rin_installer_gui_terminal_handoff_required",
        finalRequirements: finalPlan.finalRequirements,
        planPath,
        terminalCommand: buildFinalizeInstallPlanCommand(planPath),
      };
    }
    const result = await runFinalizeInstallPlanInChild(
      finalPlan.options,
      "rin install gui: applying install plan",
      { writeStatus: () => {} },
    );
    return { type: "installer:apply", ok: true, result };
  }
  return null;
}

export async function runGuiInstaller(
  rawArgv: string[] = process.argv.slice(2),
) {
  parseGuiInstallerArgs(rawArgv);
  const launch = buildGuiInstallerHostLaunch();
  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: false,
  });

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      void (async () => {
        let command: any;
        try {
          command = JSON.parse(line);
        } catch {
          return;
        }
        if (command?.type === "close") {
          child.kill();
          return;
        }
        const event = await handleGuiInstallerCommand(command);
        if (event) sendHostEvent(child.stdin, event);
      })().catch((error) => {
        const type = (() => {
          try {
            const parsed = JSON.parse(line);
            return typeof parsed?.type === "string"
              ? parsed.type
              : "installer:error";
          } catch {
            return "installer:error";
          }
        })();
        sendHostEvent(child.stdin, {
          type,
          ok: false,
          error: String(
            error?.message || error || "rin_installer_gui_command_failed",
          ),
        });
      });
    }
  });

  sendHostEvent(child.stdin, {
    type: "installer:plan",
    plan: buildGuiInstallerPlan(),
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  }).finally(() => {
    try {
      child.stdin.end();
    } catch {}
  });
}
