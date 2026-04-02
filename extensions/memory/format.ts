function escapeXml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toTitleCase(text: string): string {
  return String(text || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildResidentMemoryPrompt(result: any): string {
  const docs = Array.isArray(result?.resident_prompt_docs)
    ? result.resident_prompt_docs
    : Array.isArray(result?.resident_docs)
      ? result.resident_docs
      : [];
  if (!docs.length) return "";
  const lines = ["## Resident Memory", ""];
  for (const doc of docs) {
    const title = toTitleCase(
      String(doc?.name || doc?.resident_slot || doc?.id || "Untitled").trim(),
    );
    const body = String(doc?.content || doc?.preview || "").trim();
    const path = String(doc?.path || "").trim();
    if (!body) continue;
    lines.push(`### ${title}`);
    if (path) lines.push(path);
    lines.push("");
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildProgressiveMemoryDescription(doc: any): string {
  return String(doc?.description || "").trim();
}

function buildProgressiveMemoryPrompt(result: any): string {
  const docs = Array.isArray(result?.progressive_docs)
    ? result.progressive_docs
    : [];
  if (!docs.length) return "";
  const lines = ["## Progressive Memory", "", "<available_memory>"];
  for (const doc of docs) {
    lines.push("  <memory>");
    lines.push(
      `    <name>${escapeXml(String(doc?.name || doc?.id || "Untitled"))}</name>`,
    );
    const description = buildProgressiveMemoryDescription(doc);
    if (description) {
      lines.push(`    <description>${escapeXml(description)}</description>`);
    }
    lines.push(
      `    <location>${escapeXml(String(doc?.path || ""))}</location>`,
    );
    lines.push("  </memory>");
  }
  lines.push("</available_memory>");
  return lines.join("\n").trim();
}

export function buildCompiledMemoryPrompt(result: any): string {
  const sections = [
    buildResidentMemoryPrompt(result),
    buildProgressiveMemoryPrompt(result),
    [
      "## Expanded Progressive Memory",
      String(result?.progressive_expanded || "").trim(),
    ]
      .filter(Boolean)
      .join("\n"),
    ["## Relevant Recall", String(result?.recall_context || "").trim()]
      .filter(Boolean)
      .join("\n"),
  ].filter((body) => String(body || "").trim());
  if (!sections.length) return "";
  return ["# Memory", ...sections].join("\n\n").trim();
}

export function buildSystemPromptMemory(result: any): string {
  const sections = [
    buildResidentMemoryPrompt(result),
    buildProgressiveMemoryPrompt(result),
  ].filter((body) => String(body || "").trim());
  if (!sections.length) return "";
  return ["# Memory", ...sections].join("\n\n").trim();
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
        return `- ${String(item?.name || item?.id || "(untitled)")} [${String(item?.exposure || "")}]${scope ? ` scope=${scope}` : ""}${kind ? ` kind=${kind}` : ""}${slot ? ` slot=${slot}` : ""}${tags} path=${String(item?.path || "")}`;
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
        const summary = String(item?.description || "").trim();
        const meta = [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          String(item?.exposure || "").trim(),
          String(item?.scope || "").trim(),
        ]
          .filter(Boolean)
          .join(" • ");
        return [
          `${index + 1}. ${String(item?.name || item?.id || "(untitled)")} — ${meta}`,
          String(item?.path || ""),
          summary,
        ]
          .filter(Boolean)
          .join("\n");
      }),
    ].join("\n\n");
  }

  if (action === "save")
    return `Saved memory: ${String(response?.doc?.name || response?.doc?.id || "")}\n${String(response?.doc?.path || "")}`;

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
          `${index + 1}. ${String(item?.name || item?.id || "(untitled)")}`,
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
          `${index + 1}. ${String(item?.name || item?.id || "(untitled)")}`,
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
