import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOME_DIR = homedir();
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  formatSkillsForPrompt,
  loadSkills,
} from "../../third_party/pi-coding-agent/src/core/skills.js";
import { prepareToolTextOutput } from "../shared/tool-text.js";

function normalizeInputPath(input: string, _cwd: string): string {
  const value = input.trim();
  if (value === "~") return HOME_DIR;
  if (value.startsWith("~/")) return join(HOME_DIR, value.slice(2));
  return isAbsolute(value) ? value : resolve(HOME_DIR, value);
}

function listAncestorContextFiles(targetDir: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  let current = resolve(targetDir);
  const root = resolve("/");

  while (true) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const filePath = join(current, name);
      if (existsSync(filePath) && !seen.has(filePath)) {
        results.unshift(filePath);
        seen.add(filePath);
      }
    }
    if (current === root) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  return results;
}

function listAncestorSkillDirs(targetDir: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  let current = resolve(targetDir);
  const root = resolve("/");

  while (true) {
    const skillsDir = join(current, ".agents", "skills");
    if (existsSync(skillsDir) && !seen.has(skillsDir)) {
      results.unshift(skillsDir);
      seen.add(skillsDir);
    }
    if (current === root) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  return results;
}

function loadContextFiles(paths: string[]) {
  return paths.flatMap((filePath) => {
    try {
      return [{ path: filePath, content: readFileSync(filePath, "utf8") }];
    } catch {
      return [];
    }
  });
}

function buildRulesPrompt(targetDir: string) {
  const contextPaths = listAncestorContextFiles(targetDir);
  const skillDirs = listAncestorSkillDirs(targetDir);
  const contextFiles = loadContextFiles(contextPaths);
  const skills = loadSkills({
    cwd: targetDir,
    agentDir: join(HOME_DIR, ".rin"),
    skillPaths: skillDirs,
    includeDefaults: false,
  }).skills;

  const blocks: string[] = [];
  if (contextFiles.length > 0) {
    blocks.push(
      "# Project Context\n\nProject-specific instructions and guidelines:\n",
    );
    for (const { path, content } of contextFiles) {
      blocks.push(`## ${path}\n\n${content}`);
    }
  }
  const skillsPrompt = formatSkillsForPrompt(skills).trim();
  if (skillsPrompt) blocks.push(skillsPrompt);

  return {
    prompt: blocks.join("\n\n").trim(),
    contextPaths,
    skillDirs,
    skillCount: skills.length,
  };
}

function formatAgentText(details: {
  targetDir: string;
  prompt: string;
  contextPaths: string[];
  skillDirs: string[];
  skillCount: number;
  error?: string;
}) {
  if (details.error) return `rules error\n${details.error}`;
  if (!details.prompt) return `rules 0\ntarget=${details.targetDir}`;
  return [
    `rules target=${details.targetDir}`,
    `context_files=${details.contextPaths.length}`,
    `skill_dirs=${details.skillDirs.length}`,
    `skills=${details.skillCount}`,
    "",
    details.prompt,
  ].join("\n");
}

function formatUserText(details: {
  targetDir: string;
  prompt: string;
  contextPaths: string[];
  skillDirs: string[];
  skillCount: number;
  error?: string;
}) {
  if (details.error) return `Failed to read directory rules: ${details.error}`;
  if (!details.prompt) return `No directory rules found under ${details.targetDir}.`;
  return [
    `Directory rules collected for ${details.targetDir}:`,
    `- Parent AGENTS/CLAUDE files: ${details.contextPaths.length}`,
    `- Skill directories: ${details.skillDirs.length}`,
    `- Skill entries: ${details.skillCount}`,
  ].join("\n");
}

export default function discoverAttentionResourcesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rules",
    label: "Rules",
    description: "List rules for a target directory.",
    promptSnippet: "List rules for a target directory.",
    promptGuidelines: [
      "Use rules to get directory-level rules when switching directory context, including AGENTS.md and skills.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Target directory path, relative or absolute",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const targetPath = normalizeInputPath(
        String((params as any).path || ""),
        ctx.cwd,
      );
      let stats;
      try {
        stats = statSync(targetPath);
      } catch {
        const error = `Path does not exist: ${targetPath}`;
        const details = {
          targetDir: targetPath,
          prompt: "",
          contextPaths: [],
          skillDirs: [],
          skillCount: 0,
          error,
        };
        const prepared = await prepareToolTextOutput({
          agentText: formatAgentText(details),
          userText: formatUserText(details),
          tempPrefix: "rin-attention-resources-",
          filename: "attention-resources.txt",
        });
        return {
          content: [{ type: "text", text: prepared.agentText }],
          details: {
            targetDir: targetPath,
            contextPaths: [],
            skillDirs: [],
            skillCount: 0,
            error: true,
            ...prepared,
          },
        };
      }

      const targetDir = stats.isDirectory()
        ? targetPath
        : resolve(targetPath, "..");
      const details = {
        targetDir,
        ...buildRulesPrompt(targetDir),
      };
      const prepared = await prepareToolTextOutput({
        agentText: formatAgentText(details),
        userText: formatUserText(details),
        tempPrefix: "rin-rules-",
        filename: "rules.txt",
      });
      return {
        content: [{ type: "text", text: prepared.agentText }],
        details: { ...details, ...prepared },
      };
    },
    renderResult(result) {
      const details = result.details as any;
      const fallback =
        result.content?.[0]?.type === "text"
          ? (result.content[0] as any).text || ""
          : "";
      return new Text(String(details?.userText || fallback), 0, 0);
    },
  });
}
