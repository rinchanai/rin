function toTitleCase(text: string): string {
  return String(text || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildMemoryPromptBlock(result: any): string {
  const docs = Array.isArray(result?.memory_prompt_prompt_docs)
    ? result.memory_prompt_prompt_docs
    : Array.isArray(result?.memory_prompt_docs)
      ? result.memory_prompt_docs
      : [];
  if (!docs.length) return "";
  const lines = ["## Memory Prompts", ""];
  for (const doc of docs) {
    const title = toTitleCase(
      String(
        doc?.name || doc?.memory_prompt_slot || doc?.id || "Untitled",
      ).trim(),
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

export function buildCompiledMemoryPrompt(result: any): string {
  const sections = [
    buildMemoryPromptBlock(result),
    ["## Relevant Memory Docs", String(result?.memory_doc_context || "").trim()]
      .filter(Boolean)
      .join("\n"),
  ].filter((body) => String(body || "").trim());
  if (!sections.length) return "";
  return ["# Memory", ...sections].join("\n\n").trim();
}

export function buildSystemPromptMemory(result: any): string {
  const sections = [buildMemoryPromptBlock(result)].filter((body) =>
    String(body || "").trim(),
  );
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
        const slot = String(item?.memory_prompt_slot || "").trim();
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
        if (String(item?.sourceType || "") === "transcript") {
          const meta = [
            `score=${Number(item?.score || 0).toFixed(2)}`,
            String(item?.role || "").trim(),
            String(item?.timestamp || "").trim(),
          ]
            .filter(Boolean)
            .join(" • ");
          return [
            `${index + 1}. Transcript — ${meta}`,
            String(item?.sessionFile || "").trim(),
            String(item?.preview || item?.description || "").trim(),
          ]
            .filter(Boolean)
            .join("\n");
        }
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

  if (action === "save_memory_prompt")
    return `Saved memory prompt: ${String(response?.doc?.name || response?.doc?.id || "")}\n${String(response?.doc?.path || "")}`;

  if (action === "compile")
    return (
      buildCompiledMemoryPrompt(response) || "No compiled memory available."
    );

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
          item?.memory_prompt_slot
            ? `slot=${String(item.memory_prompt_slot)}`
            : "",
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
        String(item?.sourceType || "") === "transcript"
          ? [
              `${index + 1}. transcript`,
              `score=${Number(item?.score || 0).toFixed(2)}`,
              String(item?.role || "").trim(),
              String(item?.timestamp || "").trim(),
              `session=${String(item?.sessionFile || "")}`,
            ]
              .filter(Boolean)
              .join(" | ")
          : [
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

  if (action === "save_memory_prompt")
    return `memory save_memory_prompt\npath=${String(response?.doc?.path || "")}`;

  if (action === "compile") {
    const sections = [
      ["memory_prompts", response?.memory_prompt_docs],
      ["memory_docs", response?.memory_docs],
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

  return `memory ${action || "result"}`;
}
