import fs from "node:fs";
import path from "node:path";

export type InstallerDisplayLanguage = "en" | "zh-CN";

const LANGUAGE_ENV_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

export function canonicalizeLanguageTag(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return Intl.getCanonicalLocales(text)[0] || "";
  } catch {
    return "";
  }
}

export function normalizeLanguageTag(value: unknown, fallback = "en") {
  return canonicalizeLanguageTag(value) || fallback;
}

function isChineseLanguageTag(value: unknown) {
  const language = normalizeLanguageTag(value, "").toLowerCase();
  return language === "zh" || language.startsWith("zh-");
}

function normalizeLocaleEnvLanguageTag(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return canonicalizeLanguageTag(
    raw
      .replace(/[.:].*$/, "")
      .trim()
      .replace(/_/g, "-"),
  );
}

export function resolveInstallerDisplayLanguage(
  value: unknown,
): InstallerDisplayLanguage {
  return isChineseLanguageTag(value) ? "zh-CN" : "en";
}

export function detectLocalLanguageTag(fallback = "en") {
  for (const key of LANGUAGE_ENV_KEYS) {
    const normalized = normalizeLocaleEnvLanguageTag(process.env[key]);
    if (normalized) return normalized;
  }
  return fallback;
}

export function readConfiguredLanguageFromSettings(agentDir: string) {
  const settingsPath = path.join(agentDir, "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      language?: string;
    };
    return canonicalizeLanguageTag(settings?.language);
  } catch {
    return "";
  }
}

export function buildConfiguredLanguageSystemPrompt(languageTag: string) {
  const normalized = canonicalizeLanguageTag(languageTag);
  if (!normalized) return "";
  return [
    "Configured runtime defaults:",
    `- Preferred language: ${normalized}`,
    "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text.",
  ].join("\n");
}
