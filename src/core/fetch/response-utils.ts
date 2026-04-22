const DEFAULT_FETCH_MIME_TYPE = "application/octet-stream";
const SUPPORTED_FETCH_PROTOCOLS = new Set(["http:", "https:"]);
const TEXT_LIKE_MIME_FRAGMENTS = [
  "json",
  "xml",
  "javascript",
  "svg",
  "x-www-form-urlencoded",
] as const;

function normalizeHeaderValue(value: unknown) {
  return String(value || "").trim();
}

function normalizeMimeType(value: unknown) {
  return normalizeHeaderValue(value).toLowerCase();
}

function parseContentTypeParameter(parts: string[], name: string) {
  const normalizedName = normalizeMimeType(name);
  for (const part of parts) {
    const [key = "", ...valueParts] = String(part || "").split("=");
    if (normalizeMimeType(key) !== normalizedName) continue;
    const value = valueParts.join("=").trim().replace(/^"|"$/g, "");
    if (value) return value;
  }
  return "";
}

export function normalizeUrl(input: string) {
  const text = normalizeHeaderValue(input);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid URL: ${text || "(empty)"}`);
  }
  if (!SUPPORTED_FETCH_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function parseContentType(value: string | null) {
  const raw = normalizeHeaderValue(value);
  const [type = "", ...rest] = raw.split(";");
  const charset = parseContentTypeParameter(rest, "charset");
  return {
    mimeType: normalizeMimeType(type) || DEFAULT_FETCH_MIME_TYPE,
    charset: charset || undefined,
  };
}

export function isTextLike(mimeType: string) {
  const normalizedMimeType = normalizeMimeType(mimeType);
  return (
    normalizedMimeType.startsWith("text/") ||
    TEXT_LIKE_MIME_FRAGMENTS.some((fragment) =>
      normalizedMimeType.includes(fragment),
    )
  );
}
