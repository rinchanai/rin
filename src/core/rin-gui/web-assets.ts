export type RinGuiOptions = Record<string, never>;

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseRinGuiArgs(argv: string[]): RinGuiOptions {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg || arg === "gui") continue;
    if (arg === "--") break;
    throw new Error(`rin_gui_unrecognized_arg:${arg}`);
  }
  return {};
}
