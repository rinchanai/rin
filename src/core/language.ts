import fs from "node:fs";
import path from "node:path";

export type InstallerDisplayLanguage = "en" | "zh-CN";

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

export function resolveInstallerDisplayLanguage(
  value: unknown,
): InstallerDisplayLanguage {
  const language = normalizeLanguageTag(value, "en").toLowerCase();
  return language === "zh-cn" || language.startsWith("zh-") || language === "zh"
    ? "zh-CN"
    : "en";
}

export function detectLocalLanguageTag(fallback = "en") {
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = String(process.env[key] || "").trim();
    if (!raw) continue;
    const cleaned = raw.replace(/[.:].*$/, "").trim().replace(/_/g, "-");
    const normalized = canonicalizeLanguageTag(cleaned);
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
