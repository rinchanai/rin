export function normalizeUrl(input: string) {
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

export function parseContentType(value: string | null) {
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

export function isTextLike(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("svg") ||
    mimeType.includes("x-www-form-urlencoded")
  );
}
