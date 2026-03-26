import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
				return {
					content: [{ type: "text", text: JSON.stringify({ paths: [], error: `Path does not exist: ${targetPath}` }, null, 2) }],
					details: { paths: [], error: true },
				};
			}

			const targetDir = stats.isDirectory() ? targetPath : resolve(targetPath, "..");
			const paths = [
				...listAncestorContextFiles(targetDir),
				...collectSkillPaths(join(targetDir, ".agents", "skills")),
			];

			return {
				content: [{ type: "text", text: JSON.stringify({ paths }, null, 2) }],
				details: { paths },
			};
		},
	});
}
