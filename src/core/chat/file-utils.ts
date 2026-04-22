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

function isTextMimeType(mimeType: string) {
  return mimeType.startsWith("text/");
}

function stripQueryAndFragment(value: string) {
  return safeString(value).split(/[?#]/, 1)[0];
}

function hasTrailingPathSeparator(value: string) {
  return /(?:^|[\\/])$/.test(value);
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFallbackFileName(fallback: string) {
  return safeString(fallback) || "attachment";
}

function baseNameFromPathLike(value: string) {
  const nextValue = stripQueryAndFragment(value);
  return hasTrailingPathSeparator(nextValue) ? "" : path.basename(nextValue);
}

function pathExtension(value: string) {
  return path.extname(stripQueryAndFragment(value)).toLowerCase();
}

function fileNameFromPathLike(value: string, fallback: string) {
  return ensureFileName(
    safeDecodeURIComponent(baseNameFromPathLike(value)),
    fallback,
  );
}

export function extensionFromMimeType(
  mimeType: string,
  options: MimeExtensionOptions = {},
) {
  const mime = normalizeMimeType(mimeType);
  if (!mime) return "";
  const direct = MIME_EXTENSION_BY_TYPE.get(mime);
  if (direct) return direct;
  return options.allTextMimeTypes && isTextMimeType(mime) ? ".txt" : "";
}

export function ensureFileName(name: string, fallback = "attachment") {
  const base = safeString(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+$/, "");
  return base || fallback;
}

export function fileNameFromUrl(url: string, fallback = "attachment") {
  const nextFallback = normalizeFallbackFileName(fallback);
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
  return IMAGE_EXTENSIONS.has(pathExtension(name));
}
