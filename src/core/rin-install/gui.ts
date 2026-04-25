import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";

import { escapeHtml } from "../rin-gui/web-assets.js";
import { detectCurrentUser } from "./common.js";
import { readJsonFile } from "./fs-utils.js";
import {
  buildInstallPlanText,
  buildInstallSafetyBoundaryText,
} from "./interactive.js";
import { createInstallerI18n } from "./i18n.js";
import { defaultInstallDirForHome } from "./paths.js";
import {
  computeAvailableThinkingLevels,
  loadModelChoices,
} from "./provider-auth.js";
import { targetHomeForUser } from "./users.js";

export type GuiInstallerOptions = {
  host: string;
  port: number;
  open: boolean;
};

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

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

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
  const options: GuiInstallerOptions = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg || arg === "--gui") continue;
    if (arg === "--") break;
    if (arg === "--host") {
      options.host = String(argv[++index] || "").trim() || DEFAULT_HOST;
      continue;
    }
    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length).trim() || DEFAULT_HOST;
      continue;
    }
    if (arg === "--port") {
      options.port = parseInstallerPort(argv[++index]);
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = parseInstallerPort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
  }
  return options;
}

function parseInstallerPort(value: unknown) {
  const port = Number(String(value ?? "").trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`rin_installer_gui_invalid_port:${String(value ?? "")}`);
  }
  return port;
}

function normalizeHostForUrl(host: string) {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function openBrowser(url: string) {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: http.IncomingMessage) {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw ? JSON.parse(raw) : {};
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
    <p class="notice">This GUI-first installer shell keeps Windows users in the browser after the initial launch. Provider authentication, chat setup, and the final elevated write step are being wired into this same surface next.</p>
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
      <label class="wide"><input name="setDefaultTarget" type="checkbox" checked /> Set as the default target for this launcher user</label>
      <button class="wide" type="submit">Refresh plan</button>
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
    let modelChoices = [];

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

    async function loadModels() {
      const data = new FormData(form);
      const installDir = String(data.get('installDir') || '');
      const response = await fetch('/api/models?installDir=' + encodeURIComponent(installDir));
      const payload = await response.json();
      modelChoices = payload.models || [];
      const providers = [...new Set(modelChoices.map((model) => model.provider))];
      setOptions(providerSelect, providers.length ? providers.map((provider) => ({ value: provider, label: provider })) : [{ value: 'pending', label: 'No providers found' }], providerSelect.value);
      refreshModelFields();
      await refreshPlan();
    }

    async function refreshPlan(event) {
      if (event) event.preventDefault();
      const data = new FormData(form);
      const model = selectedModel();
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: data.get('language'),
          targetUser: data.get('targetUser'),
          installDir: data.get('installDir'),
          provider: data.get('provider'),
          modelId: data.get('modelId'),
          thinkingLevel: data.get('thinkingLevel'),
          authAvailable: Boolean(model && model.available),
          setDefaultTarget: data.get('setDefaultTarget') === 'on',
        }),
      });
      const next = await response.json();
      safety.textContent = next.safety || '';
      plan.textContent = next.planText || next.error || '';
    }
    form.elements.installDir.addEventListener('change', () => { void loadModels(); });
    providerSelect.addEventListener('change', () => { refreshModelFields(); void refreshPlan(); });
    modelSelect.addEventListener('change', () => { refreshModelFields(); void refreshPlan(); });
    thinkingSelect.addEventListener('change', () => { void refreshPlan(); });
    form.addEventListener('submit', refreshPlan);
    void loadModels().catch((error) => { modelStatus.textContent = String(error && error.message || error); });
  </script>
</body>
</html>`;
}

export async function runGuiInstaller(
  rawArgv: string[] = process.argv.slice(2),
) {
  const options = parseGuiInstallerArgs(rawArgv);
  const html = buildGuiInstallerHtml();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/models") {
      void buildGuiInstallerModelChoices(
        url.searchParams.get("installDir") || "",
      )
        .then((models) => sendJson(response, 200, { models }))
        .catch((error: any) =>
          sendJson(response, 500, {
            error: String(
              error?.message || error || "rin_installer_gui_models_failed",
            ),
          }),
        );
      return;
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      void readJsonBody(request)
        .then((body) => sendJson(response, 200, buildGuiInstallerPlan(body)))
        .catch((error: any) =>
          sendJson(response, 400, {
            error: String(
              error?.message || error || "rin_installer_gui_plan_failed",
            ),
          }),
        );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port, options.host, resolve),
  );
  const address = server.address() as AddressInfo;
  const url = `http://${normalizeHostForUrl(options.host)}:${address.port}/`;
  console.log(`rin install gui: ${url}`);
  if (options.open) openBrowser(url);
}
