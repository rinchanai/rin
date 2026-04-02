export function buildCompiledMemoryPrompt(result: any): string {
  const blocks = [
    ["## Resident Memory", String(result?.resident || "").trim()],
    ["## Progressive Memory", String(result?.progressive_index || "").trim()],
    [
      "## Expanded Progressive Memory",
      String(result?.progressive_expanded || "").trim(),
    ],
    ["## Relevant Recall", String(result?.recall_context || "").trim()],
  ].filter(([, body]) => body);
  return blocks
    .map(([title, body]) => `${title}\n${body}`)
    .join("\n\n")
    .trim();
}

export function buildSystemPromptMemory(result: any): string {
  const blocks = [
    ["## Resident Memory", String(result?.resident || "").trim()],
    ["## Progressive Memory", String(result?.progressive_index || "").trim()],
  ].filter(([, body]) => body);
  return blocks
    .map(([title, body]) => `${title}\n${body}`)
    .join("\n\n")
    .trim();
}

export function formatMemoryResult(action: string, response: any): string {
  if (action === "list") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length) return "No memory documents found.";
    return [
      `Memory documents (${rows.length}):`,
      ...rows.map((item: any) => {
        const slot = String(item?.resident_slot || "").trim();
        const tags =
          Array.isArray(item?.tags) && item.tags.length
            ? ` tags=${item.tags.join(",")}`
            : "";
        const scope = String(item?.scope || "").trim();
        const kind = String(item?.kind || "").trim();
        return `- ${String(item?.title || item?.id || "(untitled)")} [${String(item?.exposure || "")}]${scope ? ` scope=${scope}` : ""}${kind ? ` kind=${kind}` : ""}${slot ? ` slot=${slot}` : ""}${tags} path=${String(item?.path || "")}`;
      }),
    ].join("\n");
  }

  if (action === "search") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length)
      return `No memory matches for: ${String(response?.query || "")}`;
    return [
      `Memory matches for: ${String(response?.query || "")}`,
      ...rows.map((item: any, index: number) => {
        const summary = String(item?.summary || "").trim();
        const meta = [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          String(item?.exposure || "").trim(),
          String(item?.scope || "").trim(),
        ]
          .filter(Boolean)
          .join(" • ");
        return [
          `${index + 1}. ${String(item?.title || item?.id || "(untitled)")} — ${meta}`,
          String(item?.path || ""),
          summary,
        ]
          .filter(Boolean)
          .join("\n");
      }),
    ].join("\n\n");
  }

  if (action === "save")
    return `Saved memory: ${String(response?.doc?.title || response?.doc?.id || "")}\n${String(response?.doc?.path || "")}`;

  if (action === "compile")
    return (
      buildCompiledMemoryPrompt(response) || "No compiled memory available."
    );

  if (action === "doctor") {
    return [
      "Memory doctor:",
      `- root: ${String(response?.root || "")}`,
      `- total docs: ${String(response?.total || 0)}`,
      `- active docs: ${String(response?.active_total || 0)}`,
      `- inactive docs: ${String(response?.inactive_total || 0)}`,
      Array.isArray(response?.resident_missing_slots) &&
      response.resident_missing_slots.length
        ? `- missing resident slots: ${response.resident_missing_slots.join(", ")}`
        : "- missing resident slots: none",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `Memory action completed: ${action || "unknown"}`;
}

export function formatMemoryAgentResult(action: string, response: any): string {
  if (action === "list") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length) return "memory list 0";
    return [
      `memory list ${rows.length}`,
      ...rows.map((item: any, index: number) =>
        [
          `${index + 1}. ${String(item?.title || item?.id || "(untitled)")}`,
          String(item?.exposure || "").trim(),
          String(item?.scope || "").trim(),
          String(item?.kind || "").trim(),
          item?.resident_slot ? `slot=${String(item.resident_slot)}` : "",
          `path=${String(item?.path || "")}`,
        ]
          .filter(Boolean)
          .join(" | "),
      ),
    ].join("\n");
  }

  if (action === "search") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length)
      return `memory search ${String(response?.query || "")} (0)`;
    return [
      `memory search ${String(response?.query || "")} (${rows.length})`,
      ...rows.map((item: any, index: number) =>
        [
          `${index + 1}. ${String(item?.title || item?.id || "(untitled)")}`,
          `score=${Number(item?.score || 0).toFixed(2)}`,
          String(item?.exposure || "").trim(),
          String(item?.scope || "").trim(),
          `path=${String(item?.path || "")}`,
        ]
          .filter(Boolean)
          .join(" | "),
      ),
    ].join("\n");
  }

  if (action === "save")
    return `memory save\npath=${String(response?.doc?.path || "")}`;

  if (action === "compile") {
    const sections = [
      ["resident_docs", response?.resident_docs],
      ["progressive_docs", response?.progressive_docs],
      ["expanded_progressives", response?.expanded_progressives],
      ["recall_docs", response?.recall_docs],
    ].filter(([, value]) => Array.isArray(value) && value.length > 0) as Array<
      [string, any[]]
    >;
    if (!sections.length) return "memory compile 0 sources";
    return [
      `memory compile ${String(response?.query || "").trim() || "(no query)"}`,
      ...sections.map(([name, docs]) => `${name}: ${docs.length}`),
      ...sections.flatMap(([name, docs]) =>
        docs.map(
          (doc: any, index: number) =>
            `${name}[${index + 1}] path=${String(doc?.path || "")}`,
        ),
      ),
    ].join("\n");
  }

  if (action === "doctor")
    return [
      "memory doctor",
      `root=${String(response?.root || "")}`,
      `total=${String(response?.total || 0)}`,
      `active=${String(response?.active_total || 0)}`,
      Array.isArray(response?.resident_missing_slots)
        ? `missing_slots=${response.resident_missing_slots.join(",")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

  return `memory ${action || "result"}`;
}
