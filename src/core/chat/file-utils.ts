import path from "node:path";

import { safeString } from "../text-utils.js";

export type MimeExtensionOptions = {
  allTextMimeTypes?: boolean;
};

const MIME_EXTENSION_BY_TYPE = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["application/x-zip-compressed", ".zip"],
  ["application/zip", ".zip"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"],
  ["text/markdown", ".md"],
  ["text/plain", ".txt"],
]);

const IMAGE_EXTENSIONS = new Set<string>([
  ".bmp",
  ...Array.from(MIME_EXTENSION_BY_TYPE.entries())
    .filter(([mimeType]) => mimeType.startsWith("image/"))
    .map(([, extension]) => extension),
]);

function normalizeMimeType(mimeType: string) {
  return safeString(mimeType).split(";", 1)[0].toLowerCase().trim();
}

function decodeFileNameSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileNameFromPathLike(value: string, fallback: string) {
  const nextValue = safeString(value).split(/[?#]/, 1)[0];
  const baseName = /(?:^|[\\/])$/.test(nextValue)
    ? ""
    : path.basename(nextValue);
  return ensureFileName(decodeFileNameSegment(baseName), fallback);
}

export function extensionFromMimeType(
  mimeType: string,
  options: MimeExtensionOptions = {},
) {
  const mime = normalizeMimeType(mimeType);
  if (!mime) return "";
  const direct = MIME_EXTENSION_BY_TYPE.get(mime);
  if (direct) return direct;
  return options.allTextMimeTypes && mime.startsWith("text/") ? ".txt" : "";
}

export function ensureFileName(name: string, fallback = "attachment") {
  const base = safeString(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+$/, "");
  return base || fallback;
}

export function fileNameFromUrl(url: string, fallback = "attachment") {
  const nextFallback = safeString(fallback) || "attachment";
  try {
    const parsed = new URL(url);
    return fileNameFromPathLike(parsed.pathname, nextFallback);
  } catch {
    return fileNameFromPathLike(url, nextFallback);
  }
}

export function ensureExtension(
  fileName: string,
  mimeType = "",
  options: MimeExtensionOptions = {},
) {
  const nextFileName = safeString(fileName);
  if (path.extname(nextFileName)) return nextFileName;
  const ext = extensionFromMimeType(mimeType, options);
  return ext ? `${nextFileName}${ext}` : nextFileName;
}

export function isImageMimeType(mimeType: string) {
  return normalizeMimeType(mimeType).startsWith("image/");
}

export function isImageName(name: string) {
  return IMAGE_EXTENSIONS.has(
    path.extname(safeString(name).split(/[?#]/, 1)[0]).toLowerCase(),
  );
}
