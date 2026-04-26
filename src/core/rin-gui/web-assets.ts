export type RinGuiOptions = {
  platform?: NodeJS.Platform;
};

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseRinGuiArgs(argv: string[]): RinGuiOptions {
  const options: RinGuiOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg || arg === "gui") continue;
    if (arg === "--") break;

    if (arg === "--native") continue;
    if (arg === "--platform") {
      options.platform = String(argv[++index] || "").trim() as NodeJS.Platform;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      options.platform = arg
        .slice("--platform=".length)
        .trim() as NodeJS.Platform;
      continue;
    }
    if (
      arg === "--web" ||
      arg === "--host" ||
      arg.startsWith("--host=") ||
      arg === "--port" ||
      arg.startsWith("--port=") ||
      arg === "--open" ||
      arg === "--no-open" ||
      arg === "--app"
    ) {
      throw new Error(`rin_gui_browser_surface_removed:${arg}`);
    }
  }

  return options;
}
