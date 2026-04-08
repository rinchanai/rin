import fs from "node:fs/promises";
import path from "node:path";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

export type AuxiliaryModelConfig = {
  modelRef?: string;
  thinkingLevel?: string;
};

export async function loadAuxiliaryModelConfig(
  agentDir: string,
): Promise<AuxiliaryModelConfig> {
  const settingsPath = path.join(path.resolve(agentDir), "settings.json");
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const section =
      raw && typeof raw.auxiliaryModel === "object" && raw.auxiliaryModel
        ? raw.auxiliaryModel
        : {};
    const modelRef = safeString(section.model || section.modelRef || "").trim();
    const thinkingLevel = safeString(section.thinkingLevel || "").trim();
    return {
      modelRef: modelRef || undefined,
      thinkingLevel: thinkingLevel || undefined,
    };
  } catch {
    return {};
  }
}
