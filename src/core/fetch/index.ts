import { keyHint, truncateToVisualLines, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  appendTruncationNotice,
  formatTruncationWarningMessage,
  getTextOutput,
  replaceTabs,
} from "../pi/render-utils.js";
import type { TruncationResult } from "@mariozechner/pi-coding-agent";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "Rin fetch/1.0";

const FetchParamsSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
});

type FetchMode = "text";

type FetchDetails = {
  url: string;
  finalUrl: string;
  mode: FetchMode;
  status: number;
  statusText: string;
  ok: boolean;
  mimeType: string;
  charset?: string;
  bytes: number;
  title?: string;
  truncation?: TruncationResult;
};

function normalizeUrl(input: string) {
  const text = String(input || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid URL: ${text || "(empty)"}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function parseContentType(value: string | null) {
  const raw = String(value || "").trim();
  const [type, ...rest] = raw.split(";");
  let charset = "";
  for (const part of rest) {
    const match = /charset\s*=\s*([^;]+)/i.exec(part);
    if (match) {
      charset = match[1].trim().replace(/^"|"$/g, "");
      break;
    }
  }
  return {
    mimeType: type.trim().toLowerCase() || "application/octet-stream",
    charset: charset || undefined,
  };
}

function pickEncoding(charset?: string) {
  const normalized = String(charset || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "utf-8";
  if (normalized === "utf8") return "utf-8";
  if (
    [
      "utf-8",
      "utf-16le",
      "utf-16be",
      "latin1",
      "iso-8859-1",
      "windows-1252",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "utf-8";
}

function decodeBuffer(buffer: Buffer, charset?: string) {
  const encoding = pickEncoding(charset);
  try {
    return new TextDecoder(encoding as any, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

function decodeHtmlEntities(text: string) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _match;
    });
}

function normalizeRawText(text: string) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\0")
    .join("");
}

function normalizePlainText(text: string) {
  return normalizeRawText(text)
    .replace(/\t/g, "  ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHtmlTitle(html: string) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch?.[1])
    return normalizePlainText(decodeHtmlEntities(titleMatch[1]));
  const ogTitleMatch =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i.exec(
      html,
    );
  if (ogTitleMatch?.[1])
    return normalizePlainText(decodeHtmlEntities(ogTitleMatch[1]));
  return "";
}

function htmlToText(html: string) {
  let text = String(html || "");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  text = text.replace(/<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi, " ");
  text = text.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ");
  text = text.replace(/<(br|hr)\b[^>]*\/?\s*>/gi, "\n");
  text = text.replace(
    /<\/(p|div|section|article|main|aside|header|footer|nav|li|ul|ol|h[1-6]|tr|table|blockquote)>/gi,
    "\n",
  );
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = normalizePlainText(text);
  text = text.replace(/[ \f\v]+\n/g, "\n").replace(/\n[ \f\v]+/g, "\n");
  return text;
}

function maybePrettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function isProbablyHtml(mimeType: string, text: string) {
  return mimeType.includes("html") || /<html\b|<body\b|<head\b/i.test(text);
}

function isTextLike(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("svg") ||
    mimeType.includes("x-www-form-urlencoded")
  );
}

function formatTextResponse(details: FetchDetails, bodyText: string) {
  const lines = [
    `Fetched: ${details.finalUrl}`,
    `Status: ${details.status} ${details.statusText}`.trim(),
    `MIME: ${details.mimeType}`,
    `Bytes: ${details.bytes}`,
  ];
  if (details.title) lines.push(`Title: ${details.title}`);
  lines.push("", bodyText || "(empty response body)");
  return lines.join("\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

function formatFetchResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: { truncation?: TruncationResult };
  },
  options: { expanded: boolean; isPartial?: boolean },
  theme: any,
  showImages: boolean,
) {
  if (options.isPartial) return theme.fg("warning", "Fetching...");
  const output = getTextOutput(result, showImages);
  const lines = trimTrailingEmptyLines(replaceTabs(output).split("\n"));
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines
    .map((line) => theme.fg("toolOutput", replaceTabs(line)))
    .join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand" as any, "to expand")})`;
  }

  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    text += `\n${theme.fg("warning", `[${formatTruncationWarningMessage(truncation)}]`)}`;
  }
  return text;
}

export default function fetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch",
    label: "Fetch URL",
    description: "Fetch text content from a specific URL.",
    promptSnippet: "Fetch text content from a specific URL.",
    promptGuidelines: ["Use fetch to get the plain-text version of a page."],
    parameters: FetchParamsSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const mode: FetchMode = "text";
      const url = normalizeUrl(params.url);

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: { phase: "request", url, mode },
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error(`fetch_timeout:${FETCH_TIMEOUT_MS}`));
      }, FETCH_TIMEOUT_MS);
      const abortFromParent = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abortFromParent, { once: true });

      let response: Response;
      let buffer: Buffer;
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: {
            "user-agent": USER_AGENT,
            accept:
              "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.2",
          },
          signal: controller.signal,
        });
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (error: any) {
        throw new Error(
          `Fetch failed for ${url}: ${String(error?.message || error || "request_failed")}`,
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortFromParent);
      }

      const { mimeType, charset } = parseContentType(
        response.headers.get("content-type"),
      );
      const details: FetchDetails = {
        url,
        finalUrl: response.url || url,
        mode,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        mimeType,
        charset,
        bytes: buffer.byteLength,
      };

      if (!response.ok) {
        const body = isTextLike(mimeType)
          ? normalizePlainText(decodeBuffer(buffer, charset)).slice(0, 600)
          : "";
        throw new Error(
          [
            `Fetch failed: HTTP ${response.status} ${response.statusText}`.trim(),
            `URL: ${details.finalUrl}`,
            body ? `Body: ${body}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const decoded = normalizeRawText(decodeBuffer(buffer, charset));
      let bodyText = decoded;
      if (isProbablyHtml(mimeType, decoded)) {
        details.title = extractHtmlTitle(decoded) || undefined;
        bodyText = htmlToText(decoded);
      } else if (mimeType.includes("json")) {
        bodyText = maybePrettyJson(decoded);
      } else if (isTextLike(mimeType)) {
        bodyText = normalizePlainText(decoded);
      } else {
        throw new Error(`Fetch returned non-text content (${mimeType}).`);
      }

      const fullText = formatTextResponse(details, bodyText);
      const truncation = truncateHead(fullText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let outputText = truncation.content;
      if (truncation.truncated) {
        outputText = appendTruncationNotice(outputText, truncation);
        details.truncation = truncation;
      }

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("fetch"))} ${theme.fg("accent", String(args.url || ""))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatFetchResult(result as any, options as any, theme, context.showImages));
      return text;
    },
  });
}
