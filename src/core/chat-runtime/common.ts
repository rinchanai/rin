import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureExtension as ensureSharedExtension,
  ensureFileName,
  extensionFromMimeType as extensionFromSharedMimeType,
  isImageMimeType,
  isImageName,
} from "../chat/file-utils.js";
import {
  normalizeMessageText,
  renderMessageText,
} from "../message-content.js";
import { ensureDir } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

export { ensureDir, ensureFileName, isImageMimeType, isImageName, safeString };

export function extensionFromMimeType(mimeType: string) {
  return extensionFromSharedMimeType(mimeType, { allTextMimeTypes: true });
}

export function ensureExtension(fileName: string, mimeType = "") {
  return ensureSharedExtension(fileName, mimeType, {
    allTextMimeTypes: true,
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function compactObject<T extends Record<string, any>>(value: T) {
  const next: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === "string" && !item.trim()) continue;
    next[key] = item;
  }
  return next as T;
}

export function normalizeNode(
  type: string,
  attrs?: Record<string, any>,
  children?: any[],
) {
  return {
    type: safeString(type).trim().toLowerCase(),
    attrs: attrs && typeof attrs === "object" ? attrs : {},
    children: Array.isArray(children)
      ? children.flat(Infinity).filter(Boolean)
      : [],
  };
}

export function flattenNodes(value: any): any[] {
  if (!Array.isArray(value)) return value ? [value] : [];
  return value.flatMap((item) => flattenNodes(item)).filter(Boolean);
}

export function prepareOutboundNodes(content: any) {
  const nodes = flattenNodes(content)
    .map((node) =>
      typeof node === "string"
        ? normalizeNode("text", { content: node })
        : node,
    )
    .filter(Boolean);
  return {
    nodes,
    work: nodes.filter(
      (node) => safeString(node?.type).toLowerCase() !== "quote",
    ),
    replyToMessageId: extractQuoteMessageId(nodes),
  };
}

export type RenderPlainTextOptions = {
  renderAt?: (attrs: Record<string, any>) => string;
};

export function renderPlainTextFromNodes(
  nodes: any[],
  options: RenderPlainTextOptions = {},
) {
  return normalizeMessageText(
    renderMessageText(nodes, {
      normalizeChildren: normalizeMessageText,
      renderAt: (attrs) => {
        if (typeof options.renderAt === "function") {
          return safeString(options.renderAt(attrs));
        }
        const name = safeString(attrs.name).trim();
        const id = safeString(attrs.id).trim();
        if (name) return `@${name}`;
        if (id) return `@${id}`;
        return "";
      },
    }),
  );
}

export function fileUrl(filePath: string) {
  return pathToFileURL(path.resolve(filePath)).href;
}

export async function readBinaryFromNode(node: any) {
  const attrs = node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
  const name = ensureFileName(
    safeString(attrs.name).trim() ||
      `${safeString(node?.type).trim() || "file"}`,
    "file",
  );
  const mimeType = safeString(attrs.mimeType || attrs.mime || "").trim();
  if (Buffer.isBuffer(attrs.data)) {
    return {
      data: attrs.data,
      name: ensureExtension(name, mimeType),
      mimeType,
    };
  }
  const src = safeString(attrs.src || attrs.url || "").trim();
  if (!src) return null;
  if (src.startsWith("file://")) {
    const filePath = fileURLToPath(src);
    const data = await fs.promises.readFile(filePath);
    return {
      data,
      name:
        ensureExtension(path.basename(filePath), mimeType) ||
        ensureExtension(name, mimeType),
      mimeType,
    };
  }
  if (/^https?:\/\//i.test(src)) {
    return {
      url: src,
      name: ensureExtension(name, mimeType),
      mimeType,
    };
  }
  const data = await fs.promises.readFile(path.resolve(src));
  return {
    data,
    name:
      ensureExtension(path.basename(src), mimeType) ||
      ensureExtension(name, mimeType),
    mimeType,
  };
}

export function extractQuoteMessageId(nodes: any[]) {
  const quote = nodes.find(
    (node) => safeString(node?.type).toLowerCase() === "quote",
  );
  return safeString(quote?.attrs?.id || "").trim() || undefined;
}
