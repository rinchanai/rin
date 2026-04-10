function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

export function extractAssistantText(content: any) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return safeString((part as any).text);
      return "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function createFinalAssistantTextCollector() {
  let latestAssistantText = "";

  return {
    reset() {
      latestAssistantText = "";
    },
    observeEvent(event: any) {
      if (event?.type !== "message_end") return;
      if (event?.message?.role !== "assistant") return;
      const text = extractAssistantText(event.message.content);
      if (text) latestAssistantText = text;
    },
    getText() {
      return latestAssistantText;
    },
  };
}
