import path from "node:path";

import { safeString } from "../text-utils.js";

export type MimeExtensionOptions = {
  allTextMimeTypes?: boolean;
};

export function extensionFromMimeType(
  mimeType: string,
  options: MimeExtensionOptions = {},
) {
  const mime = safeString(mimeType).toLowerCase().trim();
  if (!mime) return "";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";
  if (options.allTextMimeTypes && mime.startsWith("text/")) return ".txt";
  return "";
}

export function ensureFileName(name: string, fallback = "attachment") {
  const base = safeString(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+$/, "");
  return base || fallback;
}

export function fileNameFromUrl(url: string, fallback = "attachment") {
  try {
    const pathname = new URL(url).pathname;
    const name = decodeURIComponent(path.basename(pathname));
    return ensureFileName(name, fallback);
  } catch {
    return ensureFileName(path.basename(url), fallback);
  }
}

export function ensureExtension(
  fileName: string,
  mimeType = "",
  options: MimeExtensionOptions = {},
) {
  if (path.extname(fileName)) return fileName;
  const ext = extensionFromMimeType(mimeType, options);
  return ext ? `${fileName}${ext}` : fileName;
}

export function isImageMimeType(mimeType: string) {
  return safeString(mimeType).toLowerCase().startsWith("image/");
}

export function isImageName(name: string) {
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(safeString(name));
}
