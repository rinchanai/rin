import os from "node:os";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
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

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

export function formatHiddenResultsNotice(totalResults: number, hiddenCount: number) {
  if (!(hiddenCount > 0)) return "";
  return `[Showing top ${Math.max(totalResults - hiddenCount, 0)} of ${totalResults} results.]`;
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

function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatToolDuration(startedAt: number | undefined, endedAt: number | undefined) {
  if (startedAt === undefined) return undefined;
  const label = endedAt === undefined ? "Elapsed" : "Took";
  const endTime = endedAt ?? Date.now();
  return `${label} ${formatDuration(endTime - startedAt)}`;
}

export function formatTruncationWarningMessage(truncation: TruncationResult) {
  if (truncation.firstLineExceedsLimit) {
    return `First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`;
  }
  if (truncation.truncatedBy === "lines") {
    return `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)`;
  }
  return `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`;
}

export function formatTruncationNotice(truncation: TruncationResult) {
  if (truncation.firstLineExceedsLimit) {
    return `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit.]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Showing ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
  }
  return `[Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit).]`;
}

export function appendTruncationNotice(text: string, truncation: TruncationResult | undefined) {
  if (!truncation?.truncated) return text;
  const notice = formatTruncationNotice(truncation);
  return text ? `${text}\n\n${notice}` : notice;
}

export function renderTextToolResult(
  result: {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    details?: { truncation?: TruncationResult; emptyMessage?: string };
  },
  options: { expanded: boolean; isPartial?: boolean },
  theme: any,
  showImages: boolean,
  config: {
    previewLines?: number;
    partialText?: string;
    emptyMessage?: string;
    extraMutedLines?: string[];
    truncation?: TruncationResult;
  } = {},
) {
  if (options.isPartial && config.partialText) {
    return theme.fg("warning", config.partialText);
  }

  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
  const maxLines = options.expanded ? lines.length : (config.previewLines ?? 10);
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let text = "";
  if (displayLines.length > 0) {
    text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand" as any, "to expand")})`;
    }
  } else {
    const emptyMessage = config.emptyMessage ?? result.details?.emptyMessage;
    if (emptyMessage) {
      text = `\n${theme.fg("muted", emptyMessage)}`;
    }
  }

  for (const line of config.extraMutedLines ?? []) {
    if (!line) continue;
    text += `\n${theme.fg("muted", line)}`;
  }

  const truncation = config.truncation ?? result.details?.truncation;
  if (truncation?.truncated) {
    text += `\n${theme.fg("warning", `[${formatTruncationWarningMessage(truncation)}]`)}`;
  }

  return text;
}
