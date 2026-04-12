import { existsSync, readFileSync, statSync } from "node:fs";
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
import { keyHint } from "../../third_party/pi-coding-agent/src/modes/interactive/components/keybinding-hints.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "../../third_party/pi-coding-agent/src/core/tools/truncate.js";
import {
  getTextOutput,
  invalidArgText,
  replaceTabs,
  shortenPath,
  str,
} from "../../third_party/pi-coding-agent/src/core/tools/render-utils.js";

function normalizeInputPath(input: string): string {
  return input.trim();
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

  return blocks.join("\n\n").trim();
}

function formatRulesCall(
  args: { path?: string } | undefined,
  theme: typeof import("../../third_party/pi-coding-agent/src/modes/interactive/theme/theme.js").theme,
) {
  const rawPath = str(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  return `${theme.fg("toolTitle", theme.bold("rules"))} ${path === null ? invalidArgText(theme) : theme.fg("accent", path)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatRulesResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: { truncation?: TruncationResult; emptyMessage?: string };
  },
  options: { expanded: boolean },
  theme: typeof import("../../third_party/pi-coding-agent/src/modes/interactive/theme/theme.js").theme,
  showImages: boolean,
) {
  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let text = "";
  if (displayLines.length > 0) {
    text = `\n${displayLines
      .map((line) => theme.fg("toolOutput", replaceTabs(line)))
      .join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand" as any, "to expand")})`;
    }
  } else if (result.details?.emptyMessage) {
    text = `\n${theme.fg("muted", result.details.emptyMessage)}`;
  }

  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }

  return text;
}

export default function discoverAttentionResourcesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rules",
    label: "Rules",
    description: "Get effective rules for a target directory.",
    promptSnippet: "Get effective rules for a target directory.",
    promptGuidelines: [
      "Always use rules to get directory-level rules when switching directory context, including AGENTS.md and skills.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute target directory path.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const targetPath = normalizeInputPath(String((params as any).path || ""));
      if (!targetPath) throw new Error("Path is required");
      if (!isAbsolute(targetPath)) {
        throw new Error(`Path must be absolute: ${targetPath}`);
      }
      if (!existsSync(targetPath)) {
        throw new Error(`Path not found: ${targetPath}`);
      }

      const stats = statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${targetPath}`);
      }

      const prompt = buildRulesPrompt(targetPath);
      if (!prompt) {
        return {
          content: [{ type: "text", text: "" }],
          details: {
            emptyMessage: `No directory rules found under ${targetPath}.`,
          },
        };
      }

      const truncation = truncateHead(prompt);
      let outputText = truncation.content;
      const details: { truncation?: TruncationResult; emptyMessage?: string } =
        {};
      if (truncation.truncated) {
        details.truncation = truncation;
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
        } else {
          outputText += `\n\n[Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
        }
      }

      return {
        content: [{ type: "text", text: outputText }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatRulesCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatRulesResult(result as any, options, theme, context.showImages));
      return text;
    },
  });
}
