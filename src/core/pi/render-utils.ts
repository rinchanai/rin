import os from "node:os";

import { getCapabilities, getImageDimensions, imageFallback } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";

function sanitizeBinaryOutput(str: string): string {
  return Array.from(String(str || ""))
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

export function shortenPath(value: unknown) {
  if (typeof value !== "string") return "";
  const home = os.homedir();
  if (value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}

export function str(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

export function replaceTabs(text: string) {
  return String(text || "").replace(/\t/g, "   ");
}

export function getTextOutput(
  result: {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  } | null | undefined,
  showImages: boolean,
) {
  if (!result || !Array.isArray(result.content)) return "";
  const textBlocks = result.content.filter((entry) => entry?.type === "text");
  const imageBlocks = result.content.filter((entry) => entry?.type === "image");
  let output = textBlocks
    .map((entry) =>
      sanitizeBinaryOutput(stripAnsi(String(entry?.text || ""))).replace(/\r/g, ""),
    )
    .join("\n");

  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const imageIndicators = imageBlocks
      .map((img) => {
        const mimeType = img?.mimeType ?? "image/unknown";
        const dims =
          img?.data && img?.mimeType
            ? (getImageDimensions(img.data, img.mimeType) ?? undefined)
            : undefined;
        return imageFallback(mimeType, dims);
      })
      .join("\n");
    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }

  return output;
}

export function invalidArgText(theme: any) {
  return theme.fg("error", "[invalid arg]");
}
