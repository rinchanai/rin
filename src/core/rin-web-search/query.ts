const SEARCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; RinWebSearch/1.0; +https://github.com/rinchanai/rin)";
const SUPPORTED_FRESHNESS = ["day", "week", "month", "year"] as const;

export const DIRECT_WEB_SEARCH_PROVIDERS = [
  "google-startpage",
  "yandex-html",
  "duckduckgo-html",
  "duckduckgo-lite",
] as const;

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

type FetchTextOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs?: number;
};

type DirectProvider = {
  name: (typeof DIRECT_WEB_SEARCH_PROVIDERS)[number];
  engine: string;
  search: (request: NormalizedWebSearchRequest) => Promise<WebSearchResult[]>;
};

export function safeText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function isSupportedFreshness(value: string): value is WebSearchFreshness {
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
  options: { includeDomains?: boolean } = {},
): string {
  const includeDomains = options.includeDomains !== false;
  const domainTerms = includeDomains
    ? request.domains.map((domain) => `site:${domain}`)
    : [];
  return [request.q, ...domainTerms].filter(Boolean).join(" ");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(text: string): string {
  return String(text || "").replace(
    /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_match, entity) => {
      const value = String(entity || "").toLowerCase();
      if (value === "amp") return "&";
      if (value === "lt") return "<";
      if (value === "gt") return ">";
      if (value === "quot") return '"';
      if (value === "apos") return "'";
      if (value === "nbsp") return " ";
      if (value.startsWith("#x")) {
        const code = Number.parseInt(value.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      if (value.startsWith("#")) {
        const code = Number.parseInt(value.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      return "";
    },
  );
}

function stripHtml(text: string): string {
  return safeText(
    decodeHtmlEntities(
      String(text || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  ).replace(/\s+([.,!?;:])/g, "$1");
}

function buildAcceptLanguage(language: string): string {
  const value = safeText(language);
  if (!value || value === "all") return "en-US,en;q=0.9";
  const primary = value.includes(",") ? value : `${value},en;q=0.3`;
  return primary;
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const value = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!value) return "";
  try {
    const url = new URL(
      value.startsWith("//") ? `https:${value}` : value,
      "https://duckduckgo.com",
    );
    const direct = url.searchParams.get("uddg");
    if (direct) return decodeURIComponent(direct);
    return url.toString();
  } catch {
    return value;
  }
}

function mapDuckDuckGoLanguage(language: string): string {
  const value = safeText(language).toLowerCase();
  if (!value || value === "all") return "";
  if (value.startsWith("zh")) return "cn-zh";
  if (value.startsWith("en")) return "us-en";
  if (value.startsWith("ja")) return "jp-jp";
  if (value.startsWith("fr")) return "fr-fr";
  if (value.startsWith("de")) return "de-de";
  if (value.startsWith("es")) return "es-es";
  return "";
}

function mapDuckDuckGoFreshness(freshness: string | undefined): string {
  const value = safeText(freshness).toLowerCase();
  if (value === "day") return "d";
  if (value === "week") return "w";
  if (value === "month") return "m";
  if (value === "year") return "y";
  return "";
}

function mapStartpageLanguage(language: string): string {
  const value = safeText(language).toLowerCase();
  if (!value || value === "all") return "english";
  if (value.startsWith("zh-cn") || value === "zh-hans") {
    return "chinese simplified";
  }
  if (value.startsWith("zh-tw") || value === "zh-hant") {
    return "chinese traditional";
  }
  if (value.startsWith("zh")) return "chinese simplified";
  if (value.startsWith("en")) return "english";
  if (value.startsWith("ja")) return "japanese";
  if (value.startsWith("fr")) return "french";
  if (value.startsWith("de")) return "german";
  if (value.startsWith("es")) return "spanish";
  return "english";
}

function mapStartpageFreshness(freshness: string | undefined): string {
  return mapDuckDuckGoFreshness(freshness);
}

function buildDuckDuckGoUrl(
  mode: "lite" | "html",
  request: NormalizedWebSearchRequest,
): string {
  const url = new URL(
    mode === "lite"
      ? "https://lite.duckduckgo.com/lite/"
      : "https://html.duckduckgo.com/html/",
  );
  url.searchParams.set("q", buildSearchQuery(request));
  const language = mapDuckDuckGoLanguage(request.language);
  if (language) url.searchParams.set("kl", language);
  const freshness = mapDuckDuckGoFreshness(request.freshness);
  if (freshness) url.searchParams.set("df", freshness);
  return url.toString();
}

function buildStartpageUrl(request: NormalizedWebSearchRequest): string {
  const url = new URL("https://www.startpage.com/sp/search");
  url.searchParams.set("query", buildSearchQuery(request));
  url.searchParams.set("cat", "web");
  url.searchParams.set("segment", "startpage.default.ui");
  const language = mapStartpageLanguage(request.language);
  if (language) {
    url.searchParams.set("language", language);
    url.searchParams.set("lui", language);
  }
  const freshness = mapStartpageFreshness(request.freshness);
  if (freshness) url.searchParams.set("with_date", freshness);
  return url.toString();
}

function buildYandexUrl(request: NormalizedWebSearchRequest): string {
  const url = new URL("https://yandex.com/search/");
  url.searchParams.set("text", buildSearchQuery(request, { includeDomains: false }));
  return url.toString();
}

async function fetchText(
  url: string,
  {
    method = "GET",
    headers = {},
    body = undefined,
    timeoutMs = SEARCH_TIMEOUT_MS,
  }: FetchTextOptions = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout:${timeoutMs}`)),
    Math.max(1, timeoutMs),
  );
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
        "User-Agent": USER_AGENT,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `http_${response.status}:${safeText(text || response.statusText)}`,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function buildResultRow(
  url: string,
  title: string,
  snippet: string,
  engine: string,
  position: number,
): WebSearchResult | null {
  const normalizedUrl = safeText(url);
  if (!normalizedUrl) return null;
  return {
    position,
    title: safeText(title) || "(untitled)",
    url: normalizedUrl,
    domain: hostOf(normalizedUrl),
    snippet: safeText(snippet).slice(0, 400),
    engine,
    publishedDate: "",
  };
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = safeText(hostname).toLowerCase();
  const target = safeText(domain).toLowerCase().replace(/^www\./, "");
  if (!host || !target) return false;
  return host === target || host.endsWith(`.${target}`);
}

function filterResultsByDomains(
  rows: WebSearchResult[],
  domains: string[],
): WebSearchResult[] {
  if (!domains.length) return rows;
  return rows.filter((row) =>
    domains.some((domain) => domainMatches(row.domain, domain)),
  );
}

function dedupeResults(
  rows: WebSearchResult[],
  limit: number,
): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const row of rows) {
    const url = safeText(row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ ...row, position: results.length + 1 });
    if (results.length >= limit) break;
  }
  return results;
}

function extractHref(attributes: string): string {
  return attributes.match(/\bhref=(['"])(.*?)\1/i)?.[2] || "";
}

function collectAnchorMatches(
  html: string,
  pattern: RegExp,
): Array<{ index: number; attributes: string; innerHtml: string }> {
  const matches: Array<{ index: number; attributes: string; innerHtml: string }> = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(html))) {
    matches.push({
      index: match.index,
      attributes: match[1] || "",
      innerHtml: match[3] || "",
    });
  }
  return matches;
}

function isChallengePage(html: string): boolean {
  const text = String(html || "");
  return [
    /captcha/i,
    /unusual traffic/i,
    /automated queries/i,
    /sorry\/index/i,
    /robot check/i,
  ].some((pattern) => pattern.test(text));
}

export function parseStartpageResults(html: string, limit = 8): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const matches = collectAnchorMatches(
    source,
    /<a\b([^>]*\bclass=(['"])[^'"]*\bresult-title\b[^'"]*\bresult-link\b[^'"]*\2[^>]*)>([\s\S]*?)<\/a>/gi,
  );

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const nextIndex = matches[index + 1]?.index ?? source.length;
    const segment = source.slice(current.index, nextIndex);
    const snippetMatch = segment.match(
      /<p\b[^>]*\bclass=(['"])[^'"]*\bdescription\b[^'"]*\1[^>]*>([\s\S]*?)<\/p>/i,
    );
    const row = buildResultRow(
      decodeHtmlEntities(extractHref(current.attributes)),
      stripHtml(current.innerHtml),
      stripHtml(snippetMatch?.[2] || ""),
      "google",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }

  return dedupeResults(rows, limit);
}

export function parseYandexResults(html: string, limit = 8): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const matches = collectAnchorMatches(
    source,
    /<a\b([^>]*\bclass=(['"])[^'"]*\bOrganicTitle-Link\b[^'"]*\2[^>]*)>([\s\S]*?)<\/a>/gi,
  );

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const nextIndex = matches[index + 1]?.index ?? source.length;
    const segment = source.slice(current.index, nextIndex);
    const snippetMatch = segment.match(
      /<span[^>]*\bclass=(['"])[^'"]*\bOrganicTextContentSpan\b[^'"]*\1[^>]*>([\s\S]*?)<\/span>/i,
    );
    const row = buildResultRow(
      decodeHtmlEntities(extractHref(current.attributes)),
      stripHtml(current.innerHtml),
      stripHtml(snippetMatch?.[2] || ""),
      "yandex",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }

  return dedupeResults(rows, limit);
}

export function parseDuckDuckGoLiteResults(
  html: string,
  limit = 8,
): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const pattern =
    /<a\b([^>]*\bclass=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass=['"]result-link['"]|$)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(String(html || "")))) {
    const snippetMatch = match[3].match(
      /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i,
    );
    const row = buildResultRow(
      unwrapDuckDuckGoUrl(extractHref(match[1] || "")),
      stripHtml(match[2] || ""),
      stripHtml(snippetMatch?.[1] || ""),
      "duckduckgo",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }
  return dedupeResults(rows, limit);
}

export function parseDuckDuckGoHtmlResults(
  html: string,
  limit = 8,
): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const pattern =
    /<a\b([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<h2 class="result__title"|$)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(String(html || "")))) {
    const snippetMatch = match[3].match(
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const row = buildResultRow(
      unwrapDuckDuckGoUrl(extractHref(match[1] || "")),
      stripHtml(match[2] || ""),
      stripHtml(snippetMatch?.[1] || ""),
      "duckduckgo",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }
  return dedupeResults(rows, limit);
}

async function searchStartpage(request: NormalizedWebSearchRequest) {
  const html = await fetchText(buildStartpageUrl(request), {
    headers: {
      "Accept-Language": buildAcceptLanguage(request.language),
      Referer: "https://www.startpage.com/",
    },
  });
  if (isChallengePage(html)) {
    throw new Error("google_challenge_required");
  }
  return filterResultsByDomains(
    parseStartpageResults(html, request.limit),
    request.domains,
  );
}

async function searchYandex(request: NormalizedWebSearchRequest) {
  const html = await fetchText(buildYandexUrl(request), {
    headers: {
      "Accept-Language": buildAcceptLanguage(request.language),
      Referer: "https://yandex.com/",
    },
  });
  return filterResultsByDomains(
    parseYandexResults(html, request.limit),
    request.domains,
  );
}

async function searchDuckDuckGoLite(request: NormalizedWebSearchRequest) {
  const html = await fetchText(buildDuckDuckGoUrl("lite", request), {
    headers: {
      "Accept-Language": buildAcceptLanguage(request.language),
      Referer: "https://duckduckgo.com/",
    },
  });
  return filterResultsByDomains(
    parseDuckDuckGoLiteResults(html, request.limit),
    request.domains,
  );
}

async function searchDuckDuckGoHtml(request: NormalizedWebSearchRequest) {
  const html = await fetchText(buildDuckDuckGoUrl("html", request), {
    headers: {
      "Accept-Language": buildAcceptLanguage(request.language),
      Referer: "https://duckduckgo.com/",
    },
  });
  return filterResultsByDomains(
    parseDuckDuckGoHtmlResults(html, request.limit),
    request.domains,
  );
}

const DIRECT_PROVIDER_HANDLERS: DirectProvider[] = [
  {
    name: "google-startpage",
    engine: "google",
    search: searchStartpage,
  },
  {
    name: "yandex-html",
    engine: "yandex",
    search: searchYandex,
  },
  {
    name: "duckduckgo-html",
    engine: "duckduckgo",
    search: searchDuckDuckGoHtml,
  },
  {
    name: "duckduckgo-lite",
    engine: "duckduckgo",
    search: searchDuckDuckGoLite,
  },
];

export async function searchWeb(
  input: WebSearchRequest,
): Promise<WebSearchResponse> {
  const request = normalizeSearchRequest(input);
  if (!request.q) throw new Error("web_search_query_required");

  const attempts: WebSearchAttempt[] = [];
  const collected: WebSearchResult[] = [];
  let primaryEngine = "";
  let lastError = "";

  for (const provider of DIRECT_PROVIDER_HANDLERS) {
    try {
      const results = await provider.search(request);
      attempts.push({ engine: provider.name, ok: true, results: results.length });
      if (results.length > 0) {
        if (!primaryEngine) primaryEngine = provider.engine;
        collected.push(...results);
      }
      const merged = dedupeResults(collected, request.limit);
      if (merged.length >= request.limit) {
        return {
          ok: true,
          query: request.q,
          engine: primaryEngine || provider.engine,
          attempts,
          results: merged,
        };
      }
      if (!lastError) lastError = "web_search_no_results";
    } catch (error: unknown) {
      lastError = safeText(
        error instanceof Error ? error.message : error || "web_search_failed",
      );
      attempts.push({ engine: provider.name, ok: false, error: lastError });
    }
  }

  const merged = dedupeResults(collected, request.limit);
  if (merged.length > 0) {
    return {
      ok: true,
      query: request.q,
      engine: primaryEngine || merged[0]?.engine || DIRECT_PROVIDER_HANDLERS[0].engine,
      attempts,
      results: merged,
    };
  }

  return {
    ok: false,
    query: request.q,
    engine: primaryEngine || DIRECT_PROVIDER_HANDLERS[0].engine,
    attempts,
    results: [],
    error: lastError || "web_search_no_results",
  };
}
