import { safeString } from "../platform/process.js";

const SEARCH_TIMEOUT_MS = 8_000;
const USER_AGENT = "Rin web search/1.0";
const SUPPORTED_FRESHNESS = ["day", "week", "month", "year"] as const;

export type WebSearchFreshness = (typeof SUPPORTED_FRESHNESS)[number];

export type WebSearchRequest = {
  q: string;
  limit?: number;
  domains?: string[];
  freshness?: WebSearchFreshness;
  language?: string;
};

export type WebSearchResult = {
  position: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine: string;
  publishedDate: string;
};

export type WebSearchAttempt = {
  engine: string;
  ok: boolean;
  results?: number;
  error?: string;
};

export type WebSearchResponse = {
  ok: boolean;
  query: string;
  results: WebSearchResult[];
  engine?: string;
  attempts?: WebSearchAttempt[];
  error?: string;
};

type NormalizedWebSearchRequest = {
  q: string;
  limit: number;
  domains: string[];
  freshness?: WebSearchFreshness;
  language: string;
};

type FetchJsonOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs?: number;
};

type SearxngResultRow = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  description?: unknown;
  engine?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
};

type SearxngResponse = {
  results?: SearxngResultRow[];
};

export function safeText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function isSupportedFreshness(
  value: string,
): value is WebSearchFreshness {
  return (SUPPORTED_FRESHNESS as readonly string[]).includes(value);
}

export function normalizeSearchRequest(
  raw: WebSearchRequest | null | undefined,
): NormalizedWebSearchRequest {
  const q = safeText(raw?.q);
  const limit = Math.max(1, Math.min(8, Number(raw?.limit || 5) || 5));
  const language = safeText(raw?.language) || "all";
  const freshnessValue = safeText(raw?.freshness).toLowerCase();
  const freshness = isSupportedFreshness(freshnessValue)
    ? freshnessValue
    : undefined;
  const domainValues = Array.isArray(raw?.domains) ? raw.domains : [];
  const domains = Array.from(
    new Set(domainValues.map((item) => safeText(item)).filter(Boolean)),
  ).slice(0, 8);
  return { q, limit, language, freshness, domains };
}

export function buildSearchQuery(
  request: ReturnType<typeof normalizeSearchRequest>,
): string {
  const domainTerms = request.domains.map((domain) => `site:${domain}`);
  return [request.q, ...domainTerms].filter(Boolean).join(" ");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function fetchJson<T>(
  url: string,
  {
    method = "GET",
    headers = {},
    body = undefined,
    timeoutMs = SEARCH_TIMEOUT_MS,
  }: FetchJsonOptions = {},
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout:${timeoutMs}`)),
    Math.max(1, timeoutMs),
  );
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {}
    if (!res.ok) {
      throw new Error(`http_${res.status}:${safeText(text || res.statusText)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchWeb(
  baseUrl: string,
  { q, limit, domains, freshness, language }: WebSearchRequest,
): Promise<WebSearchResponse> {
  const request = normalizeSearchRequest({
    q,
    limit,
    domains,
    freshness,
    language,
  });
  if (!request.q) throw new Error("web_search_query_required");
  if (!safeString(baseUrl).trim()) {
    throw new Error("web_search_sidecar_unavailable");
  }

  const attempts: WebSearchAttempt[] = [];
  const preferredEngines = ["google", "bing", "duckduckgo"];
  let lastError = "";

  for (const engine of preferredEngines) {
    const url = new URL("/search", `${baseUrl}/`);
    url.searchParams.set("q", buildSearchQuery(request));
    url.searchParams.set("format", "json");
    url.searchParams.set("language", request.language);
    url.searchParams.set("safesearch", "1");
    url.searchParams.set("pageno", "1");
    url.searchParams.set("categories", "general");
    url.searchParams.set("engines", engine);
    if (request.freshness) {
      url.searchParams.set("time_range", request.freshness);
    }
    try {
      const data = await fetchJson<SearxngResponse>(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      const rows = Array.isArray(data?.results) ? data.results : [];
      const results = rows
        .slice(0, request.limit)
        .map((item, index): WebSearchResult => ({
          position: index + 1,
          title: safeText(item?.title) || "(untitled)",
          url: safeText(item?.url),
          domain: hostOf(safeText(item?.url)),
          snippet: safeText(item?.content || item?.description).slice(0, 400),
          engine: safeText(item?.engine) || engine,
          publishedDate: safeText(item?.publishedDate || item?.published_date),
        }))
        .filter((item) => item.url);
      attempts.push({ engine, ok: true, results: results.length });
      if (results.length > 0) {
        return { ok: true, query: request.q, engine, attempts, results };
      }
    } catch (error) {
      lastError = safeText(error instanceof Error ? error.message : error);
      attempts.push({ engine, ok: false, error: lastError || "web_search_failed" });
    }
  }

  return {
    ok: false,
    query: request.q,
    engine: preferredEngines[preferredEngines.length - 1],
    attempts,
    results: [],
    error: lastError || "web_search_no_results",
  };
}
