import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  DefaultResourceLoader,
  type ExtensionAPI,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { resolveRuntimeProfile } from "../rin-lib/runtime.js";
import {
  invalidArgText,
  prepareTruncatedText,
  renderTextToolResult,
  shortenPath,
  str,
} from "../pi/render-utils.js";

type RulesFile = {
  path: string;
  content: string;
};

function requireTargetDirPath(params: { path?: unknown } | undefined): string {
  const targetPath = String(params?.path || "").trim();
  if (!targetPath) throw new Error("Path is required");
  if (!isAbsolute(targetPath)) {
    throw new Error(`Path must be absolute: ${targetPath}`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Path not found: ${targetPath}`);
  }
  if (!statSync(targetPath).isDirectory()) {
    throw new Error(`Not a directory: ${targetPath}`);
  }
  return targetPath;
}

export function collectRuleAncestorDirs(targetDir: string) {
  const ancestorDirs: string[] = [];
  let current = resolve(targetDir);
  const root = resolve("/");
  while (true) {
    ancestorDirs.push(current);
    if (current === root) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return ancestorDirs;
}

export function collectRelevantRulesFiles(
  targetDir: string,
  agentsFiles: Array<{ path?: string; content?: string }>,
) {
  const ancestorDirs = new Set(collectRuleAncestorDirs(targetDir));
  const filesByPath = new Map<string, RulesFile>();
  for (const agentFile of Array.isArray(agentsFiles) ? agentsFiles : []) {
    const filePath = String(agentFile?.path || "").trim();
    if (!filePath) continue;
    const resolvedPath = resolve(filePath);
    if (!ancestorDirs.has(dirname(resolvedPath))) continue;
    filesByPath.set(resolvedPath, {
      path: resolvedPath,
      content: String(agentFile?.content || "").trim(),
    });
  }
  return Array.from(filesByPath.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

export function formatRulesPrompt(contextFiles: RulesFile[]) {
  if (!contextFiles.length) return "";
  const lines = [
    "# Project Context",
    "",
    "Project-specific instructions and guidelines:",
    "",
  ];
  for (const { path: filePath, content } of contextFiles) {
    lines.push(`## ${filePath}`);
    lines.push("");
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function buildRulesPrompt(targetDir: string) {
  const { agentDir } = resolveRuntimeProfile();
  const loader = new DefaultResourceLoader({
    cwd: targetDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  return formatRulesPrompt(
    collectRelevantRulesFiles(targetDir, loader.getAgentsFiles().agentsFiles),
  );
}

function formatRulesCall(
  args: { path?: string } | undefined,
  theme: any,
) {
  const rawPath = str(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  return `${theme.fg("toolTitle", theme.bold("rules"))} ${path === null ? invalidArgText(theme) : theme.fg("accent", path)}`;
}

export default function discoverAttentionResourcesExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rules",
    label: "Rules",
    description: "Get effective rules for a target directory.",
    promptSnippet: "Get effective rules for a target directory.",
    promptGuidelines: [
      "Always use rules to get directory-level rules when switching directory context.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute target directory path.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const targetPath = requireTargetDirPath(params as { path?: unknown });

      const prompt = await buildRulesPrompt(targetPath);
      if (!prompt) {
        return {
          content: [{ type: "text", text: "" }],
          details: {},
        };
      }

      const truncated = prepareTruncatedText(prompt);
      const details: { truncation?: TruncationResult; emptyMessage?: string } =
        {};
      if (truncated.truncation) {
        details.truncation = truncated.truncation;
      }

      return {
        content: [{ type: "text", text: truncated.outputText }],
        details,
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatRulesCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        renderTextToolResult(result as any, options, theme, context.showImages),
      );
      return text;
    },
  });
}
