function toTitleCase(text: string): string {
  return String(text || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildPromptBlock(result: any): string {
  const docs = Array.isArray(result?.self_improve_prompt_prompt_docs)
    ? result.self_improve_prompt_prompt_docs
    : Array.isArray(result?.self_improve_prompt_docs)
      ? result.self_improve_prompt_docs
      : [];
  if (!docs.length) return "";
  const lines = ["# Self-Improve Prompts", ""];
  for (const doc of docs) {
    const title = toTitleCase(
      String(
        doc?.name || doc?.self_improve_prompt_slot || doc?.id || "Untitled",
      ).trim(),
    );
    const body = String(doc?.content || doc?.preview || "").trim();
    const filePath = String(doc?.path || "").trim();
    if (!body) continue;
    lines.push(`## ${title}`);
    if (filePath) lines.push(filePath);
    lines.push("");
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildCompiledSelfImprovePrompt(result: any): string {
  return buildPromptBlock(result);
}

export function buildSystemPromptSelfImprove(result: any): string {
  return buildPromptBlock(result);
}

export function formatSelfImproveResult(action: string, response: any): string {
  if (action === "list") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length) return "No self-improve prompts found.";
    return [
      `Self-improve prompts (${rows.length}):`,
      ...rows.map((item: any) => {
        const slot = String(item?.self_improve_prompt_slot || "").trim();
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
      return `No self-improve matches for: ${String(response?.query || "")}`;
    return [
      `Self-improve matches for: ${String(response?.query || "")}`,
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

  if (action === "save_self_improve_prompt") {
    return `Saved self-improve prompt: ${String(response?.doc?.name || response?.doc?.id || "")}\n${String(response?.doc?.path || "")}`;
  }

  if (action === "compile") {
    return (
      buildCompiledSelfImprovePrompt(response) ||
      "No compiled self-improve prompt available."
    );
  }

  return `Self-improve action completed: ${action || "unknown"}`;
}

export function formatSelfImproveAgentResult(
  action: string,
  response: any,
): string {
  if (action === "list") {
    const rows = Array.isArray(response?.results) ? response.results : [];
    if (!rows.length) return "self_improve list 0";
    return [
      `self_improve list ${rows.length}`,
      ...rows.map((item: any, index: number) =>
        [
          `${index + 1}. ${String(item?.name || item?.id || "(untitled)")}`,
          String(item?.exposure || "").trim(),
          String(item?.scope || "").trim(),
          String(item?.kind || "").trim(),
          item?.self_improve_prompt_slot
            ? `slot=${String(item.self_improve_prompt_slot)}`
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
      return `self_improve search ${String(response?.query || "")} (0)`;
    return [
      `self_improve search ${String(response?.query || "")} (${rows.length})`,
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

  if (action === "save_self_improve_prompt") {
    return `self_improve save_self_improve_prompt\npath=${String(response?.doc?.path || "")}`;
  }

  if (action === "compile") {
    const docs = Array.isArray(response?.self_improve_prompt_docs)
      ? response.self_improve_prompt_docs
      : [];
    return [
      `self_improve compile ${String(response?.query || "").trim() || "(no query)"}`,
      `self_improve_prompts: ${docs.length}`,
      ...docs.map(
        (doc: any, index: number) =>
          `self_improve_prompts[${index + 1}] path=${String(doc?.path || "")}`,
      ),
    ].join("\n");
  }

  return `self_improve ${action || "result"}`;
}
