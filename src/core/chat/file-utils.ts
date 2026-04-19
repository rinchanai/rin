import path from "node:path";

import { safeString } from "../text-utils.js";

export type MimeExtensionOptions = {
  allTextMimeTypes?: boolean;
};

const MIME_EXTENSION_BY_TYPE = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["text/plain", ".txt"],
]);

function normalizeMimeType(mimeType: string) {
  return safeString(mimeType).toLowerCase().trim();
}

function decodeFileNameSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileNameFromPathLike(value: string, fallback: string) {
  return ensureFileName(
    decodeFileNameSegment(path.basename(safeString(value).split(/[?#]/, 1)[0])),
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
    return fileNameFromPathLike(new URL(url).pathname, nextFallback);
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
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(safeString(name));
}
