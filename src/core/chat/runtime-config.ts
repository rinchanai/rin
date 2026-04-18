import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import YAML from "yaml";

import { listChatBridgeAdapterSpecs } from "../chat-bridge/adapters.js";
import { ensureDir, writeJsonFile } from "../platform/fs.js";
import { safeString } from "../text-utils.js";
import { getStoredChatConfigRoot } from "./settings.js";

type AdapterEntry = {
  name: string;
  config: Record<string, any>;
};

type NormalizedBuiltInChatAdapter = {
  key: string;
  pluginKey: string;
  entries: AdapterEntry[];
};

type NormalizedCustomChatAdapter = {
  packageName: string;
  version: string;
  pluginKey: string;
  fallbackPrefix: string;
  entries: AdapterEntry[];
};

type ChatRuntimePackageJson = {
  name: string;
  private: boolean;
  version: string;
  dependencies: Record<string, string>;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeChatAdapterConfig(
  value: unknown,
  defaults: Record<string, any> = {},
) {
  const current =
    value && typeof value === "object" && !Array.isArray(value)
      ? cloneJson(value)
      : {};
  return { ...defaults, ...current };
}

function sanitizeAdapterName(value: unknown, fallback: string) {
  const raw = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  return raw || fallback;
}

function looksLikeSingleAdapterConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return true;
  const singleConfigKeys = new Set([
    "name",
    "enabled",
    "endpoint",
    "selfId",
    "token",
    "protocol",
    "slash",
    "owners",
    "ownerUserIds",
    "botId",
  ]);
  if (keys.some((key) => singleConfigKeys.has(key))) return true;
  return keys.some((key) => {
    const entry = (value as Record<string, unknown>)[key];
    return !entry || typeof entry !== "object" || Array.isArray(entry);
  });
}

function normalizeAdapterEntries(
  value: unknown,
  defaults: Record<string, any>,
  fallbackPrefix: string,
): AdapterEntry[] {
  const rawEntries: AdapterEntry[] = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      rawEntries.push({
        name: sanitizeAdapterName(
          (entry as Record<string, unknown>).name,
          `${fallbackPrefix}-${index + 1}`,
        ),
        config: cloneJson(entry as Record<string, any>),
      });
    });
  } else if (looksLikeSingleAdapterConfig(value)) {
    rawEntries.push({
      name: sanitizeAdapterName(
        value && typeof value === "object"
          ? (value as Record<string, unknown>).name
          : undefined,
        fallbackPrefix,
      ),
      config:
        value && typeof value === "object"
          ? cloneJson(value as Record<string, any>)
          : {},
    });
  } else if (value && typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      rawEntries.push({
        name: sanitizeAdapterName(
          (entry as Record<string, unknown>).name || name,
          safeString(name) || fallbackPrefix,
        ),
        config: cloneJson(entry as Record<string, any>),
      });
    }
  }

  return rawEntries
    .filter((entry) => entry.config.enabled !== false)
    .map((entry) => {
      const config = normalizeChatAdapterConfig(entry.config, defaults);
      delete (config as any).name;
      delete (config as any).owners;
      delete (config as any).ownerUserIds;
      delete (config as any).botId;
      return { name: entry.name, config };
    });
}

function applyNormalizedAdapterEntries(
  plugins: Record<string, any>,
  baseName: string,
  entries: AdapterEntry[],
) {
  if (!entries.length) return;
  entries.forEach((entry, index) => {
    const key =
      index === 0 ? baseName : `${baseName}:${entry.name || index + 1}`;
    plugins[key] = entry.config;
  });
}

function normalizeCustomChatAdapters(
  chat: Record<string, any> | undefined,
): NormalizedCustomChatAdapter[] {
  const items = Array.isArray(chat?.customAdapters) ? chat.customAdapters : [];
  return items
    .map((item) => {
      const adapter =
        item && typeof item === "object" && !Array.isArray(item) ? item : null;
      const packageName = safeString((adapter as any)?.packageName).trim();
      const version = safeString((adapter as any)?.version).trim() || "latest";
      const pluginKey = safeString((adapter as any)?.pluginKey).trim();
      const defaults =
        (adapter as any)?.defaults &&
        typeof (adapter as any).defaults === "object" &&
        !Array.isArray((adapter as any).defaults)
          ? cloneJson((adapter as any).defaults)
          : {};
      const fallbackPrefix =
        safeString((adapter as any)?.name).trim() ||
        pluginKey.replace(/^adapter-/, "") ||
        packageName.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
      const config = (adapter as any)?.config;
      if (
        (adapter as any)?.enabled === false ||
        !packageName ||
        !pluginKey ||
        !config
      ) {
        return null;
      }
      return {
        packageName,
        version,
        pluginKey,
        fallbackPrefix,
        entries: normalizeAdapterEntries(config, defaults, fallbackPrefix),
      };
    })
    .filter(
      (item): item is NormalizedCustomChatAdapter => Boolean(item),
    );
}

function buildNormalizedChatRuntime(settings: unknown) {
  const chat = getStoredChatConfigRoot(settings);
  const builtInAdapters: NormalizedBuiltInChatAdapter[] =
    listChatBridgeAdapterSpecs().map((adapter) => ({
      key: adapter.key,
      pluginKey: adapter.pluginKey,
      entries: normalizeAdapterEntries(
        chat?.[adapter.key],
        adapter.defaults,
        adapter.key,
      ),
    }));
  const customAdapters = normalizeCustomChatAdapters(chat);
  const dependencies: Record<string, string> = {};

  for (const adapter of customAdapters) {
    dependencies[adapter.packageName] = adapter.version;
  }

  return {
    builtInAdapters,
    customAdapters,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ) as Record<string, string>,
  };
}

export function buildChatConfigFromSettings(settings: unknown) {
  const config = {
    name: "rin",
    prefix: ["/"],
    prefixMode: "strict",
    plugins: {
      "proxy-agent": {},
      http: {},
    } as Record<string, any>,
  };
  const runtime = buildNormalizedChatRuntime(settings);

  for (const adapter of runtime.builtInAdapters) {
    applyNormalizedAdapterEntries(
      config.plugins,
      adapter.pluginKey,
      adapter.entries,
    );
  }

  for (const adapter of runtime.customAdapters) {
    applyNormalizedAdapterEntries(
      config.plugins,
      adapter.pluginKey,
      adapter.entries,
    );
  }

  return config;
}

export type ChatRuntimeAdapterEntry = {
  key: string;
  name: string;
  config: Record<string, any>;
  builtIn: boolean;
  packageName?: string;
};

export function listChatRuntimeAdapterEntries(settings: unknown) {
  const runtime = buildNormalizedChatRuntime(settings);
  const entries: ChatRuntimeAdapterEntry[] = [];

  for (const adapter of runtime.builtInAdapters) {
    for (const entry of adapter.entries) {
      entries.push({
        key: adapter.key,
        name: entry.name,
        config: entry.config,
        builtIn: true,
      });
    }
  }

  for (const adapter of runtime.customAdapters) {
    for (const entry of adapter.entries) {
      entries.push({
        key: adapter.fallbackPrefix,
        name: entry.name,
        config: entry.config,
        builtIn: false,
        packageName: adapter.packageName,
      });
    }
  }

  return entries;
}

export function buildChatRuntimePackageJson(
  settings: unknown,
): ChatRuntimePackageJson {
  return {
    name: "rin-chat-runtime",
    private: true,
    version: "0.0.0",
    dependencies: buildNormalizedChatRuntime(settings).dependencies,
  };
}

function dependencyInstallPath(rootDir: string, packageName: string) {
  const normalized = safeString(packageName).trim();
  if (!normalized) return "";
  return path.join(rootDir, "node_modules", ...normalized.split("/"));
}

function shouldInstallChatRuntimePackage(
  rootDir: string,
  runtimePackage: ChatRuntimePackageJson,
) {
  const dependencies = runtimePackage.dependencies || {};
  if (!Object.keys(dependencies).length) return false;
  const packageJsonPath = path.join(rootDir, "package.json");
  const lockPath = path.join(rootDir, "package-lock.json");
  const expectedText = `${JSON.stringify(runtimePackage, null, 2)}\n`;
  const currentText = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : "";
  if (currentText !== expectedText) return true;
  if (!fs.existsSync(lockPath)) return true;
  return Object.keys(dependencies).some(
    (packageName) => !fs.existsSync(dependencyInstallPath(rootDir, packageName)),
  );
}

export function shouldInstallChatRuntimeDependencies(
  rootDir: string,
  settings: unknown,
) {
  return shouldInstallChatRuntimePackage(
    rootDir,
    buildChatRuntimePackageJson(settings),
  );
}

export function ensureChatRuntimeDependencies(
  rootDir: string,
  settings: unknown,
) {
  const runtimePackage = buildChatRuntimePackageJson(settings);
  const dependencies = runtimePackage.dependencies || {};
  if (!Object.keys(dependencies).length) {
    return {
      installed: false,
      dependencies,
      rootDir,
    };
  }
  if (!shouldInstallChatRuntimePackage(rootDir, runtimePackage)) {
    return {
      installed: false,
      dependencies,
      rootDir,
    };
  }
  ensureDir(rootDir);
  const packageJsonPath = path.join(rootDir, "package.json");
  writeJsonFile(packageJsonPath, runtimePackage);
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--legacy-peer-deps",
      ],
      {
        cwd: rootDir,
        stdio: "pipe",
        encoding: "utf8",
      },
    );
  } catch (error: any) {
    const detail = safeString(
      error?.stderr || error?.stdout || error?.message || error,
    ).trim();
    throw new Error(`chat_runtime_install_failed${detail ? `:${detail}` : ""}`);
  }
  return {
    installed: true,
    dependencies,
    rootDir,
  };
}

export function materializeChatConfig(configPath: string, settings: unknown) {
  const rootDir = path.dirname(configPath);
  ensureDir(rootDir);
  const config = buildChatConfigFromSettings(settings);
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  const packageJsonPath = path.join(rootDir, "package.json");
  writeJsonFile(packageJsonPath, buildChatRuntimePackageJson(settings));
  return { configPath, config };
}
