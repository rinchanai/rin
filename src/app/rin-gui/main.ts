#!/usr/bin/env node
import { runGui } from "../../core/rin-gui/main.js";
import { resolveParsedArgs } from "../../core/rin/shared.js";

const rawArgv = process.argv.slice(2);
const parsed = resolveParsedArgs("gui", {}, rawArgv);

runGui(parsed, rawArgv).catch((error: any) => {
  console.error(String(error?.message || error || "rin_gui_failed"));
  process.exit(1);
});
