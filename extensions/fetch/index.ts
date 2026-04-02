import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "Rin fetch/1.0";
const FetchModeSchema = StringEnum(["text", "raw", "file"] as const, {
  description:
    'Fetch mode: "text" = extract readable text, "raw" = raw response text, "file" = download to disk.',
});

const FetchParamsSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  mode: Type.Optional(FetchModeSchema),
  outputPath: Type.Optional(
    Type.String({
      description:
        'Optional output path for mode="file". Relative paths resolve from the current working directory.',
    }),
  ),
});

type FetchMode = "text" | "raw" | "file";

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
  outputPath?: string;
  fullOutputPath?: string;
  truncated?: boolean;
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

function sanitizeFilenamePart(value: string) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "download";
}

function extensionFromMimeType(mimeType: string) {
  const map: Record<string, string> = {
    "text/html": ".html",
    "text/plain": ".txt",
    "application/json": ".json",
    "text/markdown": ".md",
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/zip": ".zip",
    "application/gzip": ".gz",
  };
  return map[mimeType] || "";
}

function filenameFromContentDisposition(value: string | null) {
  const text = String(value || "");
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(text);
  if (utf8Match?.[1]) {
    try {
      return sanitizeFilenamePart(decodeURIComponent(utf8Match[1]));
    } catch {
      return sanitizeFilenamePart(utf8Match[1]);
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(text);
  if (quoted?.[1]) return sanitizeFilenamePart(quoted[1]);
  const plain = /filename=([^;]+)/i.exec(text);
  if (plain?.[1]) return sanitizeFilenamePart(plain[1]);
  return "";
}

function pickOutputFilename(
  finalUrl: string,
  headers: Headers,
  mimeType: string,
) {
  const fromHeader = filenameFromContentDisposition(
    headers.get("content-disposition"),
  );
  if (fromHeader) return fromHeader;
  try {
    const url = new URL(finalUrl);
    const last = path.posix.basename(url.pathname || "");
    const base = sanitizeFilenamePart(last && last !== "/" ? last : "download");
    if (path.extname(base)) return base;
    const ext = extensionFromMimeType(mimeType);
    return `${base}${ext}`;
  } catch {
    const ext = extensionFromMimeType(mimeType);
    return `download${ext}`;
  }
}

async function writeTempText(
  prefix: string,
  filename: string,
  content: string,
) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const filePath = path.join(dir, filename);
  await withFileMutationQueue(filePath, async () => {
    await writeFile(filePath, content, "utf8");
  });
  return filePath;
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

export default function fetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch",
    label: "Fetch URL",
    description: `Fetch a specific HTTP/HTTPS URL directly. mode="text" extracts readable text from webpages, mode="raw" returns raw response text, and mode="file" downloads to disk. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
    promptSnippet:
      "Fetch a specific URL directly when you already have the link. Supports readable text extraction, raw response text, and file downloads.",
    promptGuidelines: [
      "Use `fetch` when the user provides a concrete URL and wants you to read or download it directly instead of searching the web.",
      "Prefer mode=`text` for webpages, mode=`raw` when exact response text matters, and mode=`file` when the goal is to save the resource locally.",
    ],
    parameters: FetchParamsSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const mode: FetchMode = (params.mode as FetchMode | undefined) || "text";
      const url = normalizeUrl(params.url);
      if (mode !== "file" && params.outputPath) {
        throw new Error('outputPath is only valid when mode="file"');
      }

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
              mode === "file"
                ? "*/*"
                : "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.2",
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

      if (mode === "file") {
        const resolvedPath = params.outputPath
          ? path.resolve(ctx.cwd, params.outputPath)
          : path.join(
              await mkdtemp(path.join(tmpdir(), "rin-fetch-")),
              pickOutputFilename(details.finalUrl, response.headers, mimeType),
            );
        await withFileMutationQueue(resolvedPath, async () => {
          await mkdir(path.dirname(resolvedPath), { recursive: true });
          await writeFile(resolvedPath, buffer);
        });
        details.outputPath = resolvedPath;
        const text = [
          `Downloaded: ${details.finalUrl}`,
          `Saved to: ${resolvedPath}`,
          `Status: ${details.status} ${details.statusText}`.trim(),
          `MIME: ${details.mimeType}`,
          `Bytes: ${details.bytes}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details,
        };
      }

      const decoded = normalizeRawText(decodeBuffer(buffer, charset));
      let bodyText = decoded;
      if (mode === "text") {
        if (isProbablyHtml(mimeType, decoded)) {
          details.title = extractHtmlTitle(decoded) || undefined;
          bodyText = htmlToText(decoded);
        } else if (mimeType.includes("json")) {
          bodyText = maybePrettyJson(decoded);
        } else if (isTextLike(mimeType)) {
          bodyText = normalizePlainText(decoded);
        } else {
          throw new Error(
            `Fetch returned non-text content (${mimeType}). Use mode="file" to download it instead.`,
          );
        }
      }

      const fullText = formatTextResponse(details, bodyText);
      const truncation = truncateHead(fullText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let resultText = truncation.content;
      if (truncation.truncated) {
        const extension = mode === "raw" ? ".txt" : ".md";
        const fullOutputPath = await writeTempText(
          "rin-fetch-",
          `response${extension}`,
          fullText,
        );
        details.truncated = true;
        details.fullOutputPath = fullOutputPath;
        resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
      }

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },
    renderCall(args, theme) {
      const mode = args.mode ? ` (${args.mode})` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("fetch"))}${theme.fg("muted", mode)} ${theme.fg("accent", String(args.url || ""))}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      const details = (result.details || {}) as FetchDetails;
      if (!details.finalUrl) {
        const fallback =
          result.content?.[0]?.type === "text"
            ? result.content[0].text
            : "(no output)";
        return new Text(fallback, 0, 0);
      }
      let text = theme.fg("success", `${details.status} ${details.mimeType}`);
      if (details.title) text += `\n${theme.fg("accent", details.title)}`;
      text += `\n${theme.fg("dim", details.finalUrl)}`;
      if (details.outputPath)
        text += `\n${theme.fg("muted", details.outputPath)}`;
      if (details.truncated && details.fullOutputPath) {
        text += `\n${theme.fg("warning", `truncated → ${details.fullOutputPath}`)}`;
      }
      if (expanded && result.content?.[0]?.type === "text") {
        const lines = result.content[0].text.split("\n").slice(0, 16);
        text += `\n\n${theme.fg("dim", lines.join("\n"))}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
