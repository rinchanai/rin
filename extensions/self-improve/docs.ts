import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import {
  MemoryDoc,
  MemoryExposure,
  MEMORY_PROMPT_LIMITS,
  MEMORY_PROMPT_SLOTS,
} from "./core/types.js";
import {
  parseMarkdownDoc,
  previewMemoryDoc,
  renderMarkdownDoc,
} from "./core/schema.js";
import { safeString } from "./core/utils.js";

export async function walkMarkdownFiles(dirPath: string): Promise<string[]> {
  if (!fssync.existsSync(dirPath)) return [];
  const out: string[] = [];
  const visit = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(fullPath);
    }
  };
  await visit(dirPath);
  return out.sort();
}

function selfImprovePromptsDir(rootDir: string) {
  return path.join(rootDir, "prompts");
}

export async function loadMemoryDocs(rootDir: string): Promise<MemoryDoc[]> {
  const files = await walkMarkdownFiles(selfImprovePromptsDir(rootDir));
  const docs: MemoryDoc[] = [];
  for (const filePath of files)
    docs.push(parseMarkdownDoc(filePath, await fs.readFile(filePath, "utf8")));
  return docs;
}

export function loadMemoryDocsSync(rootDir: string): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  const visit = (dirPath: string) => {
    if (!fssync.existsSync(dirPath)) return;
    const entries = fssync.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          docs.push(
            parseMarkdownDoc(fullPath, fssync.readFileSync(fullPath, "utf8")),
          );
        } catch {}
      }
    }
  };
  visit(selfImprovePromptsDir(rootDir));
  return docs.sort((a, b) =>
    safeString(a.path).localeCompare(safeString(b.path)),
  );
}

export async function resolveMemoryDoc(
  rootDir: string,
  query: string,
): Promise<MemoryDoc | null> {
  const raw = safeString(query).trim();
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? raw : path.join(rootDir, raw);
  if (fssync.existsSync(abs) && abs.endsWith(".md"))
    return parseMarkdownDoc(abs, await fs.readFile(abs, "utf8"));
  const docs = await loadMemoryDocs(rootDir);
  return (
    docs.find(
      (doc) => doc.id === raw || doc.self_improve_prompt_slot === raw,
    ) || null
  );
}

export function memoryPromptPath(rootDir: string, slot: string): string {
  return path.join(rootDir, "prompts", `${slot}.md`);
}

export function assertMemoryPromptDoc(doc: MemoryDoc): void {
  const slot = safeString(doc.self_improve_prompt_slot).trim();
  if (!MEMORY_PROMPT_SLOTS.includes(slot as any))
    throw new Error(
      `self_improve_prompt_slot_required:${MEMORY_PROMPT_SLOTS.join(",")}`,
    );
  const limits = MEMORY_PROMPT_LIMITS[slot];
  if (!limits) throw new Error(`self_improve_prompt_slot_invalid:${slot}`);
  if (!limits.fidelity.includes(doc.fidelity))
    throw new Error(
      `self_improve_prompt_fidelity_invalid:${slot}:${doc.fidelity}`,
    );
  if (safeString(doc.content).trim().length > limits.maxChars)
    throw new Error(
      `self_improve_prompt_content_too_long:${slot}:${limits.maxChars}`,
    );
}

export async function writeMemoryDoc(doc: MemoryDoc) {
  await fs.mkdir(path.dirname(doc.path), { recursive: true });
  await fs.writeFile(doc.path, renderMarkdownDoc(doc), "utf8");
}

export function previewDocs(docs: MemoryDoc[]) {
  return docs.map(previewMemoryDoc);
}
