import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const query = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "query.js"),
  ).href
);
const paths = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "paths.js"),
  ).href
);
const service = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "service.js"),
  ).href
);

const startpageFixture = `
<div class="result css-o7i03b">
  <a class="result-title result-link css-1bggj8v" href="https://github.com/rinchanai/rin" target="_blank" rel="noopener nofollow noreferrer">
    <h2 class="wgl-title css-i3irj7">GitHub - rinchanai/rin</h2>
  </a>
  <p class="description css-1507v2l">Rin personal workspace mirror managed by <b>RinChan</b>.</p>
</div>`;

const yandexFixture = `
<li class="serp-item serp-item_card ">
  <div class="VanillaReact OrganicTitle OrganicTitle_size_l">
    <a target="_blank" class="Link Link_theme_normal OrganicTitle-Link link" href="https://example.com/yandex-result">
      <h2 class="OrganicTitle-LinkText"><span class="OrganicTitleContentSpan" role="text">Yandex Result Title</span></h2>
    </a>
  </div>
  <div class="Organic-ContentWrapper">
    <div class="TextContainer OrganicText Typo Typo_text_m Typo_line_m">
      <span role="text" class="OrganicTextContentSpan">Yandex fallback snippet for <b>RinChan</b>.</span>
    </div>
  </div>
</li>`;

const duckDuckGoLiteFixture = `
<table>
  <tr>
    <td>1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Frinchanai%2Frin&amp;rut=abc" class='result-link'>GitHub - rinchanai/rin</a>
    </td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>Rin personal workspace mirror managed by <b>RinChan</b>.</td>
  </tr>
</table>`;

const duckDuckGoHtmlFixture = `
<div class="results">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=def">Example Guide</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=def">A <b>helpful</b> guide.</a>
</div>`;

test("web search query helpers normalize request", () => {
  const req = query.normalizeSearchRequest({
    q: "  hello ",
    limit: 99,
    domains: ["a.com", "a.com", "b.com"],
  });
  assert.equal(req.q, "hello");
  assert.equal(req.limit, 8);
  assert.deepEqual(req.domains, ["a.com", "b.com"]);
  assert.equal(query.buildSearchQuery(req), "hello site:a.com site:b.com");
});

test("web search query helpers discard invalid freshness", () => {
  const req = query.normalizeSearchRequest({
    q: " demo ",
    freshness: "decade",
    language: "  zh-CN  ",
  });
  assert.equal(req.q, "demo");
  assert.equal(req.language, "zh-CN");
  assert.equal(req.freshness, undefined);
});

test("web search paths derive data root location", () => {
  const root = "/tmp/demo";
  assert.ok(
    paths
      .dataRootForState(root)
      .endsWith(path.join("data", "web-search")),
  );
});

test("startpage parser extracts google-compatible direct results", () => {
  const rows = query.parseStartpageResults(startpageFixture, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, "google");
  assert.equal(rows[0].url, "https://github.com/rinchanai/rin");
  assert.equal(rows[0].title, "GitHub - rinchanai/rin");
  assert.equal(rows[0].snippet, "Rin personal workspace mirror managed by RinChan.");
  assert.equal(rows[0].domain, "github.com");
});

test("yandex parser extracts direct results", () => {
  const rows = query.parseYandexResults(yandexFixture, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, "yandex");
  assert.equal(rows[0].url, "https://example.com/yandex-result");
  assert.equal(rows[0].title, "Yandex Result Title");
  assert.equal(rows[0].snippet, "Yandex fallback snippet for RinChan.");
  assert.equal(rows[0].domain, "example.com");
});

test("duckduckgo lite parser extracts direct results", () => {
  const rows = query.parseDuckDuckGoLiteResults(duckDuckGoLiteFixture, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, "duckduckgo");
  assert.equal(rows[0].url, "https://github.com/rinchanai/rin");
  assert.equal(rows[0].title, "GitHub - rinchanai/rin");
  assert.equal(rows[0].snippet, "Rin personal workspace mirror managed by RinChan.");
  assert.equal(rows[0].domain, "github.com");
});

test("duckduckgo html parser extracts direct results", () => {
  const rows = query.parseDuckDuckGoHtmlResults(duckDuckGoHtmlFixture, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, "duckduckgo");
  assert.equal(rows[0].url, "https://example.com/guide");
  assert.equal(rows[0].title, "Example Guide");
  assert.equal(rows[0].snippet, "A helpful guide.");
  assert.equal(rows[0].domain, "example.com");
});

test("web search service reports direct provider runtime status", () => {
  const status = service.getWebSearchStatus("/tmp/rin-agent");
  assert.equal(status.runtime.ready, true);
  assert.equal(status.runtime.mode, "direct");
  assert.equal(status.runtime.providerCount, 4);
  assert.deepEqual(status.runtime.providers, [
    "google-startpage",
    "yandex-html",
    "duckduckgo-html",
    "duckduckgo-lite",
  ]);
  assert.deepEqual(status.instances, []);
});

test("web search uses google-compatible results first and fills gaps from fallback providers", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    startpageFixture,
    yandexFixture,
  ];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.equal(result.results.length, 2);
    assert.deepEqual(
      result.results.map((item) => [item.engine, item.url]),
      [
        ["google", "https://github.com/rinchanai/rin"],
        ["yandex", "https://example.com/yandex-result"],
      ],
    );
    assert.deepEqual(
      result.attempts?.map((item) => [item.engine, item.ok, item.results ?? 0]),
      [
        ["google-startpage", true, 1],
        ["yandex-html", true, 1],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search falls back when google-compatible provider is challenged", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    '<html><body><h1>CAPTCHA</h1><p>automated queries detected</p></body></html>',
    yandexFixture,
  ];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "yandex");
    assert.deepEqual(
      result.attempts,
      [
        {
          engine: "google-startpage",
          ok: false,
          error: "google_challenge_required",
        },
        {
          engine: "yandex-html",
          ok: true,
          results: 1,
        },
      ],
    );
    assert.equal(result.results[0].url, "https://example.com/yandex-result");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
