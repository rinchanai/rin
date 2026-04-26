import { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  extractSubcommandArgv,
  ParsedArgs,
} from "../rin/shared.js";

import { runNativeDesktopGui } from "./native-desktop.js";
import { parseRinGuiArgs } from "./web-assets.js";

export async function runGui(parsed: ParsedArgs, rawArgv: string[] = []) {
  const guiArgs = extractSubcommandArgv(rawArgv, "gui");
  const options = parseRinGuiArgs(guiArgs);
  const context = createTargetExecutionContext(parsed);

  await ensureDaemonAvailable(context);

  const client = new RinDaemonFrontendClient(context.socketPath);
  await client.connect();
  try {
    await runNativeDesktopGui({
      client,
      title: "Rin",
      platform: options.platform,
    });
  } finally {
    await client.disconnect();
  }
}
