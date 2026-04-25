const SEARCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; RinWebSearch/1.0; +https://github.com/rinchanai/rin)";
const SUPPORTED_FRESHNESS = ["day", "week", "month", "year"] as const;

export const DIRECT_WEB_SEARCH_PROVIDERS = [
  "google",
  "bing",
  "duckduckgo",
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
  if (value.includes(",")) return value;
  return `${value},en;q=0.3`;
}

function parseLocale(
  language: string,
): { lang: string; region: string } | null {
  const value = safeText(language);
  if (!value || value === "all") return null;

  const normalized = value.replace(/_/g, "-");
  const parts = normalized.split("-").filter(Boolean);
  if (!parts.length) return null;

  const lang = parts[0]!.toLowerCase();
  let region = parts[1]?.toUpperCase() || "";

  if (!region) {
    if (lang === "zh") region = "CN";
    else if (lang === "en") region = "US";
    else if (lang === "ja") region = "JP";
    else if (lang === "fr") region = "FR";
    else if (lang === "de") region = "DE";
    else if (lang === "es") region = "ES";
  }

  return { lang, region };
}

function mapGoogleLanguage(language: string) {
  const locale = parseLocale(language);
  if (!locale) {
    return { hl: "en-US", lr: "", gl: "" };
  }

  if (locale.lang === "zh") {
    if (locale.region === "TW" || locale.region === "HK") {
      return { hl: `zh-${locale.region}`, lr: "lang_zh-TW", gl: locale.region };
    }
    return { hl: "zh-CN", lr: "lang_zh-CN", gl: locale.region || "CN" };
  }

  if (locale.lang === "en") {
    return {
      hl: locale.region ? `en-${locale.region}` : "en-US",
      lr: "lang_en",
      gl: locale.region,
    };
  }

  return {
    hl: locale.region ? `${locale.lang}-${locale.region}` : locale.lang,
    lr: `lang_${locale.lang}`,
    gl: locale.region,
  };
}

function mapBingMarket(language: string): string {
  const locale = parseLocale(language);
  if (!locale) return "";
  if (!locale.region) return "";
  return `${locale.lang}-${locale.region}`;
}

function mapFreshness(freshness: string | undefined): string {
  const value = safeText(freshness).toLowerCase();
  if (value === "day") return "d";
  if (value === "week") return "w";
  if (value === "month") return "m";
  if (value === "year") return "y";
  return "";
}

function buildGoogleUrl(request: NormalizedWebSearchRequest): string {
  const url = new URL("https://www.google.com/search");
  const language = mapGoogleLanguage(request.language);
  url.searchParams.set("q", buildSearchQuery(request));
  url.searchParams.set("hl", language.hl);
  url.searchParams.set("ie", "utf8");
  url.searchParams.set("oe", "utf8");
  url.searchParams.set("filter", "0");
  url.searchParams.set("num", String(Math.max(request.limit, 10)));
  if (language.lr) url.searchParams.set("lr", language.lr);
  if (language.gl) url.searchParams.set("gl", language.gl);
  const freshness = mapFreshness(request.freshness);
  if (freshness) url.searchParams.set("tbs", `qdr:${freshness}`);
  return url.toString();
}

function mapStartpageLanguage(language: string): string {
  const locale = parseLocale(language);
  if (!locale) return "english";
  if (locale.lang === "zh") return "chinese";
  if (locale.lang === "ja") return "japanese";
  if (locale.lang === "de") return "deutsch";
  if (locale.lang === "fr") return "francais";
  if (locale.lang === "es") return "espanol";
  if (locale.lang === "it") return "italiano";
  if (locale.lang === "pt") return "portugues";
  if (locale.lang === "ru") return "russian";
  return "english";
}

function buildStartpageUrl(request: NormalizedWebSearchRequest): string {
  const url = new URL("https://www.startpage.com/do/dsearch");
  url.searchParams.set("query", buildSearchQuery(request));
  url.searchParams.set("cat", "web");
  url.searchParams.set("language", mapStartpageLanguage(request.language));
  const freshness = mapFreshness(request.freshness);
  if (freshness) url.searchParams.set("with_date", freshness);
  return url.toString();
}

function buildBingUrl(request: NormalizedWebSearchRequest): string {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", buildSearchQuery(request));
  url.searchParams.set("adlt", "moderate");
  const market = mapBingMarket(request.language);
  if (market) url.searchParams.set("mkt", market);
  return url.toString();
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
  const locale = parseLocale(request.language);
  if (locale?.region) {
    url.searchParams.set("kl", `${locale.region.toLowerCase()}-${locale.lang}`);
  }
  const freshness = mapFreshness(request.freshness);
  if (freshness) url.searchParams.set("df", freshness);
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
  const target = safeText(domain)
    .toLowerCase()
    .replace(/^www\./, "");
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
  const matches: Array<{
    index: number;
    attributes: string;
    innerHtml: string;
  }> = [];
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
    /challenge-form/i,
  ].some((pattern) => pattern.test(text));
}

function unwrapGoogleUrl(rawUrl: string): string {
  const value = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!value) return "";
  try {
    const url = new URL(value, "https://www.google.com");
    if (url.pathname === "/url") {
      const direct = url.searchParams.get("q");
      return direct ? decodeURIComponent(direct) : "";
    }
    if (
      url.pathname.startsWith("/search") ||
      url.pathname.startsWith("/settings")
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function unwrapBingUrl(rawUrl: string): string {
  const value = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!value) return "";
  try {
    const url = new URL(value, "https://www.bing.com");
    if (url.hostname === "www.bing.com" && url.pathname === "/ck/a") {
      const encoded = url.searchParams.get("u") || "";
      if (encoded.startsWith("a1")) {
        const base64 = encoded.slice(2);
        const padded = `${base64}${"=".repeat((4 - (base64.length % 4 || 4)) % 4)}`;
        return Buffer.from(padded, "base64url").toString("utf8");
      }
      return "";
    }
    return url.toString();
  } catch {
    return value;
  }
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

export function parseGoogleResults(html: string, limit = 8): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const matches = collectAnchorMatches(
    source,
    /<a\b([^>]*\bhref=(['"])(?:\/url\?q=|https?:\/\/|\/)[\s\S]*?\2[^>]*)>([\s\S]*?)<\/a>/gi,
  );

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const nextIndex = matches[index + 1]?.index ?? source.length;
    const segment = source.slice(current.index, nextIndex);
    const rawUrl = extractHref(current.attributes);
    const url = unwrapGoogleUrl(rawUrl);
    if (!url || hostOf(url).endsWith("google.com")) continue;

    const title = stripHtml(current.innerHtml);
    if (!title || title.toLowerCase() === "cached") continue;

    const snippetMatch = segment.match(
      /<(?:div|span)\b[^>]*\bclass=(['"])[^'"]*(?:VwiC3b|yXK7lf|s3v9rd|st)[^'"]*\1[^>]*>([\s\S]*?)<\/(?:div|span)>/i,
    );

    const row = buildResultRow(
      url,
      title,
      stripHtml(snippetMatch?.[2] || ""),
      "google",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }

  return dedupeResults(rows, limit);
}

export function parseStartpageResults(
  html: string,
  limit = 8,
): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const pattern =
    /<div\b[^>]*class=(['"])[^'"]*\bresult\b[^'"]*\1[^>]*>([\s\S]*?)(?=<div\b[^>]*class=(['"])[^'"]*\bresult\b|<div\b[^>]*class=(['"])[^'"]*\ba-bg-result\b|$)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(source))) {
    const section = match[2] || "";
    let title = "";
    let url = "";

    for (const anchor of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attributes = anchor[1] || "";
      if (!/\bclass=(['"])[^'"]*\bresult-(?:title|link)\b/i.test(attributes)) {
        continue;
      }
      url = decodeHtmlEntities(extractHref(attributes));
      title = stripHtml(anchor[2] || "");
      if (url && title) break;
    }

    const snippetMatch = section.match(
      /<(?:p|div)\b[^>]*\bclass=(['"])[^'"]*(?:description|snippet|summary)[^'"]*\1[^>]*>([\s\S]*?)<\/(?:p|div)>/i,
    );
    const row = buildResultRow(
      url,
      title,
      stripHtml(snippetMatch?.[2] || ""),
      "google",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }

  return dedupeResults(rows, limit);
}

export function parseBingResults(html: string, limit = 8): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const sections = source.match(
    /<li\b[^>]*\bclass=(['"])[^'"]*\bb_algo\b[^'"]*\1[\s\S]*?<\/li>/gi,
  );

  for (const section of sections || []) {
    const linkMatch = section.match(/<h2[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = unwrapBingUrl(extractHref(linkMatch[1] || ""));
    const title = stripHtml(linkMatch[2] || "");
    const snippetMatch = section.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = String(snippetMatch?.[1] || "").replace(
      /<span[^>]*class=(['"])[^'"]*algoSlug_icon[^'"]*\1[^>]*>[\s\S]*?<\/span>/gi,
      " ",
    );
    const row = buildResultRow(
      url,
      title,
      stripHtml(snippet),
      "bing",
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
    /<a\b([^>]*\bclass=(['"])[^'"]*\bresult__a\b[^'"]*\2[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<h2[^>]*\bclass=(['"])[^'"]*\bresult__title\b|$)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(String(html || "")))) {
    const snippetMatch = match[4].match(
      /<(?:a|div)[^>]*class=(['"])[^'"]*\bresult__snippet\b[^'"]*\1[^>]*>([\s\S]*?)<\/(?:a|div)>/i,
    );
    const row = buildResultRow(
      unwrapDuckDuckGoUrl(extractHref(match[1] || "")),
      stripHtml(match[3] || ""),
      stripHtml(snippetMatch?.[2] || ""),
      "duckduckgo",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }
  return dedupeResults(rows, limit);
}

async function searchGoogle(request: NormalizedWebSearchRequest) {
  const headers = {
    "Accept-Language": buildAcceptLanguage(request.language),
    Cookie: "CONSENT=YES+",
    Referer: "https://www.google.com/",
  };
  let primaryError = "";

  try {
    const html = await fetchText(buildGoogleUrl(request), { headers });
    if (isChallengePage(html)) {
      throw new Error("google_challenge_required");
    }
    const directRows = filterResultsByDomains(
      parseGoogleResults(html, request.limit),
      request.domains,
    );
    if (directRows.length > 0) return directRows;
  } catch (error) {
    primaryError = safeText(
      error instanceof Error ? error.message : error || "google_failed",
    );
  }

  try {
    const html = await fetchText(buildStartpageUrl(request), {
      headers: {
        "Accept-Language": buildAcceptLanguage(request.language),
        Referer: "https://www.startpage.com/",
      },
    });
    if (isChallengePage(html) || /startpage captcha/i.test(html)) {
      throw new Error("google_startpage_challenge_required");
    }
    const startpageRows = filterResultsByDomains(
      parseStartpageResults(html, request.limit),
      request.domains,
    );
    if (startpageRows.length > 0) return startpageRows;
  } catch (error) {
    if (primaryError) throw new Error(primaryError);
    throw error;
  }

  if (primaryError) throw new Error(primaryError);
  return [];
}

async function searchBing(request: NormalizedWebSearchRequest) {
  const html = await fetchText(buildBingUrl(request), {
    headers: {
      "Accept-Language": buildAcceptLanguage(request.language),
      Referer: "https://www.bing.com/",
    },
  });
  if (isChallengePage(html)) {
    throw new Error("bing_challenge_required");
  }
  return filterResultsByDomains(
    parseBingResults(html, request.limit),
    request.domains,
  );
}

async function searchDuckDuckGo(request: NormalizedWebSearchRequest) {
  const headers = {
    "Accept-Language": buildAcceptLanguage(request.language),
    Referer: "https://duckduckgo.com/",
  };

  try {
    const html = await fetchText(buildDuckDuckGoUrl("html", request), {
      headers,
    });
    if (isChallengePage(html)) {
      throw new Error("duckduckgo_challenge_required");
    }
    const rows = filterResultsByDomains(
      parseDuckDuckGoHtmlResults(html, request.limit),
      request.domains,
    );
    if (rows.length > 0) return rows;
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : error);
    if (message && !message.includes("no_results")) {
      // continue to lite fallback
    }
  }

  const lite = await fetchText(buildDuckDuckGoUrl("lite", request), {
    headers,
  });
  if (isChallengePage(lite)) {
    throw new Error("duckduckgo_challenge_required");
  }
  return filterResultsByDomains(
    parseDuckDuckGoLiteResults(lite, request.limit),
    request.domains,
  );
}

const DIRECT_PROVIDER_HANDLERS: DirectProvider[] = [
  { name: "google", search: searchGoogle },
  { name: "bing", search: searchBing },
  { name: "duckduckgo", search: searchDuckDuckGo },
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
      attempts.push({
        engine: provider.name,
        ok: true,
        results: results.length,
      });
      if (results.length > 0) {
        if (!primaryEngine) primaryEngine = provider.name;
        collected.push(...results);
      }
      const merged = dedupeResults(collected, request.limit);
      if (merged.length >= request.limit) {
        return {
          ok: true,
          query: request.q,
          engine: primaryEngine || provider.name,
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
      engine:
        primaryEngine || merged[0]?.engine || DIRECT_PROVIDER_HANDLERS[0].name,
      attempts,
      results: merged,
    };
  }

  return {
    ok: false,
    query: request.q,
    engine: primaryEngine || DIRECT_PROVIDER_HANDLERS[0].name,
    attempts,
    results: [],
    error: lastError || "web_search_no_results",
  };
}
