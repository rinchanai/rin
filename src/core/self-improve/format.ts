function toSentenceCaseLabel(text: string) {
  const parts = String(text || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (!parts.length) return "";
  parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.join(" ");
}

function trimText(value: unknown) {
  return String(value || "").trim();
}

function collectPromptDocs(result: any) {
  return [
    ...(Array.isArray(result?.self_improve_prompt_prompt_docs)
      ? result.self_improve_prompt_prompt_docs
      : []),
    ...(Array.isArray(result?.self_improve_prompt_docs)
      ? result.self_improve_prompt_docs
      : []),
  ];
}

function getPromptDocBody(doc: any) {
  return trimText(doc?.content || doc?.preview);
}

function getPromptDocLabel(doc: any) {
  return toSentenceCaseLabel(
    trimText(doc?.self_improve_prompt_slot || doc?.id || doc?.name),
  );
}

function getPromptDocPath(doc: any) {
  return trimText(doc?.path);
}

function buildPromptBlock(result: any): string {
  const lines: string[] = [];
  for (const doc of collectPromptDocs(result)) {
    const body = getPromptDocBody(doc);
    const label = getPromptDocLabel(doc);
    if (!body || !label) continue;
    lines.push(`${label}:`);
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function normalizeResultRows(response: any) {
  return Array.isArray(response?.results) ? response.results : [];
}

function formatMetaParts(parts: unknown[], separator: string) {
  return parts.map((part) => trimText(part)).filter(Boolean).join(separator);
}

function formatTags(tags: unknown) {
  return Array.isArray(tags)
    ? tags.map((tag) => trimText(tag)).filter(Boolean).join(",")
    : "";
}

function getItemName(item: any) {
  return trimText(item?.name || item?.id) || "(untitled)";
}

function formatListRowText(item: any, index: number, compact: boolean) {
  const exposure = trimText(item?.exposure);
  const scope = trimText(item?.scope);
  const kind = trimText(item?.kind);
  const slot = trimText(item?.self_improve_prompt_slot);
  const itemPath = getPromptDocPath(item);
  const tags = formatTags(item?.tags);
  const metaParts = compact
    ? [
        exposure,
        scope,
        kind,
        slot ? `slot=${slot}` : "",
        itemPath ? `path=${itemPath}` : "",
      ]
    : [
        exposure ? `[${exposure}]` : "",
        scope ? `scope=${scope}` : "",
        kind ? `kind=${kind}` : "",
        slot ? `slot=${slot}` : "",
        tags ? `tags=${tags}` : "",
        itemPath ? `path=${itemPath}` : "",
      ];
  const meta = formatMetaParts(metaParts, compact ? " | " : " ");
  return compact
    ? `${index + 1}. ${getItemName(item)}${meta ? ` | ${meta}` : ""}`
    : `- ${getItemName(item)}${meta ? ` ${meta}` : ""}`;
}

function formatSearchRowText(item: any, index: number, compact: boolean) {
  const meta = compact
    ? formatMetaParts(
        [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          trimText(item?.exposure),
          trimText(item?.scope),
          getPromptDocPath(item) ? `path=${getPromptDocPath(item)}` : "",
        ],
        " | ",
      )
    : formatMetaParts(
        [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          trimText(item?.exposure),
          trimText(item?.scope),
        ],
        " • ",
      );
  const summary = trimText(item?.description);
  if (compact) {
    return `${index + 1}. ${getItemName(item)}${meta ? ` | ${meta}` : ""}`;
  }
  return [
    `${index + 1}. ${getItemName(item)}${meta ? ` — ${meta}` : ""}`,
    getPromptDocPath(item),
    summary,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCompiledSelfImprovePrompt(result: any): string {
  return buildPromptBlock(result);
}

export function buildSystemPromptSelfImprove(result: any): string {
  return buildPromptBlock(result);
}

export function formatSelfImproveResult(action: string, response: any): string {
  if (action === "list") {
    const rows = normalizeResultRows(response);
    if (!rows.length) return "No self-improve prompts found.";
    return [
      `Self-improve prompts (${rows.length}):`,
      ...rows.map((item: any, index: number) =>
        formatListRowText(item, index, false),
      ),
    ].join("\n");
  }

  if (action === "search") {
    const rows = normalizeResultRows(response);
    const query = trimText(response?.query);
    if (!rows.length) {
      return `No self-improve matches for: ${query}`;
    }
    return [
      `Self-improve matches for: ${query}`,
      ...rows.map((item: any, index: number) =>
        formatSearchRowText(item, index, false),
      ),
    ].join("\n\n");
  }

  if (action === "save_self_improve_prompt") {
    return [
      `Saved self-improve prompt: ${getItemName(response?.doc)}`,
      getPromptDocPath(response?.doc),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "compile") {
    return (
      buildCompiledSelfImprovePrompt(response) ||
      "No compiled self-improve prompt available."
    );
  }

  return `Self-improve action completed: ${trimText(action) || "unknown"}`;
}

export function formatSelfImproveAgentResult(
  action: string,
  response: any,
): string {
  if (action === "list") {
    const rows = normalizeResultRows(response);
    if (!rows.length) return "self_improve list 0";
    return [
      `self_improve list ${rows.length}`,
      ...rows.map((item: any, index: number) =>
        formatListRowText(item, index, true),
      ),
    ].join("\n");
  }

  if (action === "search") {
    const rows = normalizeResultRows(response);
    const query = trimText(response?.query);
    if (!rows.length) return `self_improve search ${query} (0)`;
    return [
      `self_improve search ${query} (${rows.length})`,
      ...rows.map((item: any, index: number) =>
        formatSearchRowText(item, index, true),
      ),
    ].join("\n");
  }

  if (action === "save_self_improve_prompt") {
    return [
      "self_improve save_self_improve_prompt",
      getPromptDocPath(response?.doc)
        ? `path=${getPromptDocPath(response?.doc)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "compile") {
    const query = trimText(response?.query) || "(no query)";
    const docs = collectPromptDocs(response)
      .map((doc: any, index: number) => {
        const docPath = getPromptDocPath(doc);
        return docPath ? `self_improve_prompts[${index + 1}] path=${docPath}` : "";
      })
      .filter(Boolean);
    return [
      `self_improve compile ${query}`,
      `self_improve_prompts: ${docs.length}`,
      ...docs,
    ].join("\n");
  }

  return `self_improve ${trimText(action) || "result"}`;
}
