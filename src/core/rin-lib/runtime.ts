import os from "node:os";
import path from "node:path";

import { loadRinCodingAgent } from "./loader.js";

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: any[]) {
  const visibleSkills = (Array.isArray(skills) ? skills : []).filter(
    (skill) => skill && !skill.disableModelInvocation,
  );
  if (!visibleSkills.length) return "";
  const lines = [
    "Available skills provide specialized instructions for specific tasks.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(String(skill.name || ""))}</name>`);
    lines.push(
      `    <description>${escapeXml(String(skill.description || ""))}</description>`,
    );
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildRinDocsBlock(agentDir: string) {
  const rinRoot = path.join(agentDir, "docs", "rin");
  const rinDocsRoot = path.join(rinRoot, "docs");
  const piRoot = path.join(agentDir, "docs", "pi");
  return [
    "Rin and Pi documentation (read only when the user asks about Rin, Pi, or their SDKs, extensions, themes, skills, TUI, or daemons; if Rin and Pi docs conflict, Rin docs take precedence):",
    `- Main Rin documentation: ${path.join(rinRoot, "README.md")}`,
    `- Additional Rin docs: ${rinDocsRoot}`,
    `- Main Pi documentation: ${path.join(piRoot, "README.md")}`,
    `- Additional Pi docs: ${path.join(piRoot, "docs")}`,
    `- Pi examples: ${path.join(piRoot, "examples")} (extensions, custom tools, SDK)`,
    "- When asked about: Rin overrides (docs/pi-overrides.md), runtime layout (docs/runtime-layout.md), builtin extensions (docs/builtin-extensions.md), capabilities (docs/capabilities.md); Pi extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
  ].join("\n");
}

function buildRinSystemPrompt(session: any, toolNames: string[]) {
  const validToolNames = toolNames.filter((name) =>
    session._toolRegistry.has(name),
  );
  const toolSnippets: Record<string, string> = {};
  const promptGuidelines: string[] = [];
  for (const name of validToolNames) {
    const snippet = session._toolPromptSnippets.get(name);
    if (snippet) toolSnippets[name] = snippet;
    const toolGuidelineSet = session._toolPromptGuidelines.get(name);
    if (toolGuidelineSet) promptGuidelines.push(...toolGuidelineSet);
  }

  const uniqueGuidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (value: string) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    uniqueGuidelines.push(normalized);
  };

  const hasBash = validToolNames.includes("bash");
  const hasGrep = validToolNames.includes("grep");
  const hasFind = validToolNames.includes("find");
  const hasLs = validToolNames.includes("ls");
  const hasRead = validToolNames.includes("read");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }
  let deferredSaveMemoryGuideline = "";
  let deferredSaveMemoryPromptGuideline = "";
  for (const guideline of promptGuidelines) {
    if (guideline.startsWith("Use save_memory ")) {
      deferredSaveMemoryGuideline = guideline;
      continue;
    }
    if (guideline.startsWith("Use save_memory_prompt ")) {
      deferredSaveMemoryPromptGuideline = guideline;
      continue;
    }
    addGuideline(guideline);
  }
  if (deferredSaveMemoryPromptGuideline) {
    addGuideline(deferredSaveMemoryPromptGuideline);
  }
  if (deferredSaveMemoryGuideline) {
    addGuideline(deferredSaveMemoryGuideline);
  }
  addGuideline(
    "Always use skill-creator (/home/rin/.rin/docs/rin/builtin-skills/skill-creator/SKILL.md) to maintain standard Agent Skills format memory documents.",
  );
  addGuideline(
    "Write all memory in English, keeping proper nouns untranslated.",
  );
  addGuideline("All memory documents use the standard Agent Skills format.");
  addGuideline(
    "Each memory document should contain only one topic; when multiple topics are related, prefer designing an index document to build a tree structure and disclose only that index.",
  );
  addGuideline(
    "Always search memory proactively before beginning substantial work, scanning across all relevant scales from precise task details to broader domain context.",
  );
  addGuideline(
    "Search the web proactively for latest, time-sensitive, version-sensitive, or potentially changed information.",
  );
  addGuideline(
    "When searching, use a few distinctive keywords instead of full sentences.",
  );
  addGuideline(
    "When searching, search distinct keywords separately and review the results instead of combining everything into one search.",
  );
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const toolsList =
    validToolNames.length > 0
      ? validToolNames
          .filter((name) => Boolean(toolSnippets[name]))
          .map((name) => `- ${name}: ${toolSnippets[name]}`)
          .join("\n") || "(none)"
      : "(none)";

  const guidelines = uniqueGuidelines.map((g) => `- ${g}`).join("\n");
  const loaderSystemPrompt = session._resourceLoader.getSystemPrompt();
  const appendSystemPromptList =
    session._resourceLoader.getAppendSystemPrompt();
  const appendSystemPrompt =
    appendSystemPromptList.length > 0
      ? appendSystemPromptList.join("\n\n")
      : "";
  const loadedSkills = session._resourceLoader.getSkills().skills;
  const loadedContextFiles =
    session._resourceLoader.getAgentsFiles().agentsFiles;
  const docsBlock = buildRinDocsBlock(
    session._resourceLoader.agentDir ||
      process.env.RIN_DIR ||
      path.join(os.homedir(), ".rin"),
  );

  let prompt = String(loaderSystemPrompt || "").trim();
  if (!prompt) {
    prompt = [
      "Available tools:",
      toolsList,
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      guidelines,
      "",
      docsBlock,
    ].join("\n");
  } else {
    prompt = [prompt, docsBlock].filter(Boolean).join("\n\n");
  }

  if (appendSystemPrompt) prompt += `\n\n${appendSystemPrompt}`;
  if (loadedContextFiles.length > 0) {
    prompt +=
      "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of loadedContextFiles) {
      prompt += `## ${filePath}\n\n${content}\n\n`;
    }
  }
  if (hasRead && loadedSkills.length > 0) {
    prompt += formatSkillsForPrompt(loadedSkills);
  }
  return prompt.trimEnd();
}

function applyRinPromptBuilder(session: any) {
  if (!session || typeof session !== "object") return;
  const originalRebuild =
    typeof session._rebuildSystemPrompt === "function"
      ? session._rebuildSystemPrompt.bind(session)
      : null;
  if (!originalRebuild) return;

  session._rebuildSystemPrompt = (toolNames: string[]) => {
    try {
      return buildRinSystemPrompt(
        session,
        Array.isArray(toolNames) ? toolNames : [],
      );
    } catch {
      return originalRebuild(toolNames);
    }
  };

  let activeToolNames: string[] = [];
  try {
    if (typeof session.getActiveToolNames === "function") {
      activeToolNames = session.getActiveToolNames();
    }
  } catch {}

  try {
    const next = session._rebuildSystemPrompt(activeToolNames);
    if (String(next || "").trim()) {
      session._baseSystemPrompt = next;
      if (session.agent?.state && typeof session.agent.state === "object") {
        session.agent.state.systemPrompt = next;
      }
      if (typeof session.agent?.setSystemPrompt === "function") {
        session.agent.setSystemPrompt(next);
      }
    }
  } catch {}
}

export const RIN_DIR_ENV = "RIN_DIR";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function resolveRuntimeProfile(
  options: { cwd?: string; agentDir?: string } = {},
) {
  const cwd = options.cwd || os.homedir();
  const agentDir =
    options.agentDir ||
    process.env[RIN_DIR_ENV]?.trim() ||
    path.join(os.homedir(), ".rin");
  return { cwd, agentDir };
}

export function applyRuntimeProfileEnvironment(profile: { agentDir: string }) {
  if (profile.agentDir) {
    process.env[PI_AGENT_DIR_ENV] = profile.agentDir;
  }
}

export function getRuntimeSessionDir(cwd: string, agentDir: string) {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safePath);
}

export async function createConfiguredAgentSession(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
    sessionManager?: any;
    modelRef?: string;
    thinkingLevel?: any;
  } = {},
) {
  const codingAgentModule = await loadRinCodingAgent();
  const {
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    SessionManager,
  } = codingAgentModule as any;

  const { cwd, agentDir } = resolveRuntimeProfile({
    cwd: options.cwd,
    agentDir: options.agentDir,
  });

  applyRuntimeProfileEnvironment({ agentDir });

  const initialSessionManager =
    options.sessionManager ||
    SessionManager.create(cwd, getRuntimeSessionDir(cwd, agentDir));

  const createRuntime = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }: {
    cwd: string;
    agentDir: string;
    sessionManager: any;
    sessionStartEvent?: any;
  }) => {
    if (process.cwd() !== runtimeCwd) {
      process.chdir(runtimeCwd);
    }
    applyRuntimeProfileEnvironment({ agentDir: runtimeAgentDir });

    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.additionalExtensionPaths ?? [],
      },
    });

    let resolvedModel: any = undefined;
    const modelRef = String(options.modelRef || "").trim();
    if (modelRef) {
      const slash = modelRef.indexOf("/");
      if (slash <= 0 || slash >= modelRef.length - 1) {
        throw new Error(`invalid_model_ref:${modelRef}`);
      }
      const provider = modelRef.slice(0, slash);
      const modelId = modelRef.slice(slash + 1);
      resolvedModel = services.modelRegistry.find(provider, modelId);
      if (!resolvedModel) throw new Error(`unknown_model:${modelRef}`);
      if (!services.modelRegistry.hasConfiguredAuth(resolvedModel)) {
        throw new Error(`No API key for ${modelRef}`);
      }
    }

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: resolvedModel,
      thinkingLevel: options.thinkingLevel,
    });

    applyRinPromptBuilder(result.session);
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: initialSessionManager.getCwd?.() || cwd,
    agentDir,
    sessionManager: initialSessionManager,
  });

  return {
    session: runtime.session,
    runtime,
    extensionsResult: runtime.session.resourceLoader.getExtensions(),
    modelFallbackMessage: runtime.modelFallbackMessage,
  };
}
