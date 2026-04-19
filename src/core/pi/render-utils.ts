import os from "node:os";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
  truncateToVisualLines,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Text,
  getCapabilities,
  getImageDimensions,
  imageFallback,
  truncateToWidth,
} from "@mariozechner/pi-tui";
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

type ToolContentEntry = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

type TextToolContent = {
  content?: ToolContentEntry[];
};

type TextToolResult = TextToolContent & {
  details?: { truncation?: TruncationResult; emptyMessage?: string };
};

export const NO_OUTPUT_TEXT = "(no output)";

function collectTextOutput(
  result: TextToolContent | null | undefined,
): { outputText: string; imageBlocks: ToolContentEntry[] } {
  const textParts: string[] = [];
  const imageBlocks: ToolContentEntry[] = [];
  if (!Array.isArray(result?.content)) {
    return { outputText: "", imageBlocks };
  }

  for (const entry of result.content) {
    if (entry?.type === "text") {
      textParts.push(
        sanitizeBinaryOutput(stripAnsi(String(entry.text || ""))).replace(/\r/g, ""),
      );
      continue;
    }
    if (entry?.type === "image") imageBlocks.push(entry);
  }

  return {
    outputText: textParts.join("\n"),
    imageBlocks,
  };
}

export function getTextOutput(
  result: TextToolContent | null | undefined,
  showImages: boolean,
) {
  const { outputText, imageBlocks } = collectTextOutput(result);
  let output = outputText;

  if (imageBlocks.length > 0) {
    const caps = getCapabilities();
    if (caps.images && showImages) return output;
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

export function getToolResultText(
  result: TextToolContent | null | undefined,
  showImages: boolean,
  fallback = NO_OUTPUT_TEXT,
) {
  return getTextOutput(result, showImages) || fallback;
}

export function getToolResultUserText(
  result: TextToolContent | null | undefined,
  showImages: boolean,
  userText: unknown,
  fallback = NO_OUTPUT_TEXT,
) {
  return str(userText) || getToolResultText(result, showImages, fallback);
}

export function buildUserFacingTextResult(
  result: TextToolContent | null | undefined,
  showImages: boolean,
  config: {
    userText?: unknown;
    fallback?: string;
    details?: Record<string, unknown>;
  } = {},
) {
  return {
    content: [
      {
        type: "text" as const,
        text: getToolResultUserText(
          result,
          showImages,
          config.userText,
          config.fallback,
        ),
      },
    ],
    details: config.details ?? {},
  };
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

function describeTruncation(truncation: TruncationResult) {
  const byteLimit = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
  if (truncation.firstLineExceedsLimit) {
    return {
      warning: `First line exceeds ${byteLimit} limit`,
      notice: `First line exceeds ${byteLimit} limit`,
    };
  }
  if (truncation.truncatedBy === "lines") {
    return {
      warning: `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)`,
      notice: `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
    };
  }
  return {
    warning: `Truncated: ${truncation.outputLines} lines shown (${byteLimit} limit)`,
    notice: `Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${byteLimit} limit)`,
  };
}

export function formatTruncationWarningMessage(truncation: TruncationResult) {
  return describeTruncation(truncation).warning;
}

export function formatTruncationNotice(truncation: TruncationResult) {
  return `[${describeTruncation(truncation).notice}.]`;
}

export function appendTruncationNotice(text: string, truncation: TruncationResult | undefined) {
  if (!truncation?.truncated) return text;
  const notice = formatTruncationNotice(truncation);
  return text ? `${text}\n\n${notice}` : notice;
}

type TruncateTextOptions = Parameters<typeof truncateHead>[1];

export function prepareTruncatedText(text: string, options?: TruncateTextOptions) {
  const result = truncateHead(text, options);
  const truncation = result.truncated ? result : undefined;
  return {
    outputText: appendTruncationNotice(result.content, truncation),
    previewText: result.content,
    truncation,
  };
}

export function prepareTruncatedAgentUserText(
  agentText: string,
  userText: string,
  options?: TruncateTextOptions,
) {
  const agent = prepareTruncatedText(agentText, options);
  if (agentText === userText) {
    return {
      ...agent,
      userPreviewText: agent.previewText,
      userTruncation: agent.truncation,
    };
  }

  const user = prepareTruncatedText(userText, options);
  return {
    ...agent,
    userPreviewText: user.previewText,
    userTruncation: user.truncation,
  };
}

export type ExpandableTextResultRenderState = {
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
};

export class ExpandableTextResultComponent extends Container {
  state: ExpandableTextResultRenderState = {
    cachedWidth: undefined,
    cachedLines: undefined,
    cachedSkipped: undefined,
  };
}

export function rebuildExpandableTextResultComponent(
  component: ExpandableTextResultComponent,
  config: {
    outputText: string;
    expanded: boolean;
    previewLines?: number;
    fullOutputPath?: string;
    truncation?: TruncationResult;
    startedAt?: number;
    endedAt?: number;
  },
  theme: any,
) {
  const state = component.state;
  component.clear();

  const output = String(config.outputText || "").trim();
  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (config.expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(
              styledOutput,
              config.previewLines ?? 5,
              width,
            );
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }
          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand" as any, "to expand")})`;
            return [
              "",
              truncateToWidth(hint, width, "..."),
              ...(state.cachedLines ?? []),
            ];
          }
          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }

  if (config.truncation?.truncated || config.fullOutputPath) {
    const warnings: string[] = [];
    if (config.fullOutputPath) warnings.push(`Full output: ${config.fullOutputPath}`);
    if (config.truncation?.truncated) {
      warnings.push(formatTruncationWarningMessage(config.truncation));
    }
    component.addChild(
      new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0),
    );
  }

  const duration = formatToolDuration(config.startedAt, config.endedAt);
  if (duration) {
    component.addChild(new Text(`\n${theme.fg("muted", duration)}`, 0, 0));
  }
}

export function renderTextToolResult(
  result: TextToolResult,
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
