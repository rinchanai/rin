import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from '@mariozechner/pi-tui'
import { Type } from "@sinclair/typebox";

function normalizeInputPath(input: string, cwd: string): string {
	const value = input.trim();
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
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

function collectSkillPaths(skillsDir: string): string[] {
	if (!existsSync(skillsDir)) return [];

	const results: string[] = [];
	const visit = (dir: string) => {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		const skillFile = join(dir, "SKILL.md");
		if (existsSync(skillFile)) {
			results.push(dir);
			return;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry);
			let stats;
			try {
				stats = statSync(fullPath);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				visit(fullPath);
			}
		}
	};

	visit(skillsDir);
	return results;
}

function formatAgentText(paths: string[], error?: string): string {
	if (error) return `attention_resources error\n${error}`;
	if (!paths.length) return 'attention_resources 0';
	return ['attention_resources', ...paths].join('\n');
}

function formatUserText(targetDir: string, paths: string[], error?: string): string {
	if (error) return `无法发现 attention resources：${error}`;
	if (!paths.length) return `在 ${targetDir} 下没有找到 attention resources。`;
	return [
		`在 ${targetDir} 下找到 ${paths.length} 个 attention resources：`,
		...paths.map((item) => `- ${item}`),
	].join('\n');
}

export default function discoverAttentionResourcesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "discover_attention_resources",
		label: "Discover Attention Resources",
		description:
			"List prompt-relevant local resource paths for a target directory. Returns absolute paths to ancestor AGENTS/CLAUDE files and .agents/skills skill directories.",
		parameters: Type.Object({
			path: Type.String({ description: "Target directory path, relative or absolute" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const targetPath = normalizeInputPath(String((params as any).path || ""), ctx.cwd);
			let stats;
			try {
				stats = statSync(targetPath);
			} catch {
				const error = `Path does not exist: ${targetPath}`;
				return {
					content: [{ type: "text", text: formatAgentText([], error) }],
					details: { paths: [], error: true, agentText: formatAgentText([], error), userText: formatUserText(targetPath, [], error) },
				};
			}

			const targetDir = stats.isDirectory() ? targetPath : resolve(targetPath, "..");
			const paths = [
				...listAncestorContextFiles(targetDir),
				...collectSkillPaths(join(targetDir, ".agents", "skills")),
			];
			const agentText = formatAgentText(paths);
			const userText = formatUserText(targetDir, paths);
			return {
				content: [{ type: "text", text: agentText }],
				details: { paths, agentText, userText },
			};
		},
		renderResult(result) {
			const details = result.details as any;
			const fallback = result.content?.[0]?.type === 'text' ? (result.content[0] as any).text || '' : '';
			return new Text(String(details?.userText || fallback), 0, 0);
		},
	});
}
