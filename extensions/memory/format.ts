export function buildCompiledMemoryPrompt(result: any): string {
  const blocks = [
    ["## Resident Memory", String(result?.resident || "").trim()],
    ["## Progressive Memory", String(result?.progressive_index || "").trim()],
    [
      "## Expanded Progressive Memory",
      String(result?.progressive_expanded || "").trim(),
    ],
    ["## Episode Memory", String(result?.episode_context || "").trim()],
    ["## Relevant Recall", String(result?.recall_context || "").trim()],
    ["## Related Memory", String(result?.related_context || "").trim()],
    ["## Relevant Recent History", String(result?.recent_history || "").trim()],
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
    const events = Array.isArray(response?.event_matches)
      ? response.event_matches
      : [];
    const related = Array.isArray(response?.related_matches)
      ? response.related_matches
      : [];
    const parts: string[] = [];
    parts.push(
      rows.length
        ? [
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
          ].join("\n\n")
        : `No memory matches for: ${String(response?.query || "")}`,
    );
    if (related.length)
      parts.push(
        [
          "Related memory edges:",
          ...related.map(
            (item: any, index: number) =>
              `${index + 1}. ${String(item?.title || item?.id || "")} (${String(item?.reason || "related")})`,
          ),
        ].join("\n"),
      );
    if (events.length)
      parts.push(
        [
          "Relevant event ledger entries:",
          ...events.map(
            (item: any, index: number) =>
              `${index + 1}. [${String(item?.created_at || "")
                .replace("T", " ")
                .slice(0, 16)}] ${String(item?.summary || "")}`,
          ),
        ].join("\n"),
      );
    return parts.join("\n\n");
  }
  if (action === "save")
    return `Saved memory: ${String(response?.doc?.title || response?.doc?.id || "")}\n${String(response?.doc?.path || "")}`;
  if (action === "delete")
    return `Deleted memory: ${String(response?.id || "")}\n${String(response?.path || "")}`;
  if (action === "move")
    return `Moved memory: ${String(response?.doc?.title || response?.doc?.id || "")}\n${String(response?.doc?.path || "")}`;
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
      `- events: ${String(response?.event_count || 0)}`,
      `- relation edges: ${String(response?.relation_edges || 0)}`,
      `- chronicles: ${String(response?.chronicle_docs || 0)}`,
      `- episodes: ${String(response?.episode_docs || 0)}`,
      response?.last_processed_at
        ? `- last processed at: ${String(response.last_processed_at)}`
        : "",
      Array.isArray(response?.resident_missing_slots) &&
      response.resident_missing_slots.length
        ? `- missing resident slots: ${response.resident_missing_slots.join(", ")}`
        : "- missing resident slots: none",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (action === "log_event")
    return `Logged memory event: ${String(response?.event?.id || "")}\n${String(response?.event?.summary || "")}`;
  if (action === "events" || action === "event_search") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length)
      return action === "event_search"
        ? `No event matches for: ${String(response?.query || "")}`
        : "No memory events found.";
    return rows
      .map(
        (item: any, index: number) =>
          `${index + 1}. [${String(item?.created_at || "")
            .replace("T", " ")
            .slice(0, 16)}] ${String(item?.summary || "")}`,
      )
      .join("\n");
  }
  if (action === "process") {
    const lines = [
      "Memory processing finished.",
      response?.status ? `- status: ${String(response.status)}` : "",
      response?.sessionFile
        ? `- session file: ${String(response.sessionFile)}`
        : "",
      response?.lastProcessedAt
        ? `- last processed at: ${String(response.lastProcessedAt)}`
        : "",
    ];
    const counts =
      response?.counts && typeof response.counts === "object"
        ? Object.entries(response.counts)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", ")
        : "";
    if (counts) lines.push(`- counts: ${counts}`);
    return lines.filter(Boolean).join("\n");
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
    const related = Array.isArray(response?.related_matches)
      ? response.related_matches
      : [];
    const events = Array.isArray(response?.event_matches)
      ? response.event_matches
      : [];
    const parts: string[] = [];
    parts.push(
      rows.length
        ? [
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
          ].join("\n")
        : `memory search ${String(response?.query || "")} (0)`,
    );
    if (related.length)
      parts.push(
        [
          "related",
          ...related.map(
            (item: any, index: number) =>
              `${index + 1}. ${String(item?.title || item?.id || "")} | reason=${String(item?.reason || "related")} | path=${String(item?.path || "")}`,
          ),
        ].join("\n"),
      );
    if (events.length)
      parts.push(
        [
          "events",
          ...events.map(
            (item: any, index: number) =>
              `${index + 1}. ${String(item?.created_at || "")} | ${String(item?.summary || "")}`,
          ),
        ].join("\n"),
      );
    return parts.join("\n\n");
  }
  if (action === "save")
    return `memory save\npath=${String(response?.doc?.path || "")}`;
  if (action === "delete")
    return `memory delete\npath=${String(response?.path || "")}`;
  if (action === "move")
    return `memory move\npath=${String(response?.doc?.path || "")}`;
  if (action === "compile") {
    const sections = [
      ["resident_docs", response?.resident_docs],
      ["progressive_docs", response?.progressive_docs],
      ["expanded_progressives", response?.expanded_progressives],
      ["episode_docs", response?.episode_docs],
      ["recall_docs", response?.recall_docs],
      ["related_docs", response?.related_docs],
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
      `events=${String(response?.event_count || 0)}`,
      `relation_edges=${String(response?.relation_edges || 0)}`,
      Array.isArray(response?.resident_missing_slots)
        ? `missing_slots=${response.resident_missing_slots.join(",")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  if (action === "log_event")
    return `memory log_event\nid=${String(response?.event?.id || "")}`;
  if (action === "events" || action === "event_search") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length)
      return action === "event_search"
        ? `memory event_search ${String(response?.query || "")} (0)`
        : "memory events 0";
    return [
      action === "event_search"
        ? `memory event_search ${String(response?.query || "")} (${rows.length})`
        : `memory events ${rows.length}`,
      ...rows.map(
        (item: any, index: number) =>
          `${index + 1}. ${String(item?.created_at || "")} | ${String(item?.summary || "")}`,
      ),
    ].join("\n");
  }
  if (action === "process")
    return [
      "memory process",
      `status=${String(response?.status || response?.ok || "ok")}`,
      response?.sessionFile
        ? `sessionFile=${String(response.sessionFile)}`
        : "",
      response?.lastProcessedAt
        ? `lastProcessedAt=${String(response.lastProcessedAt)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  return `memory ${action || "result"}`;
}
