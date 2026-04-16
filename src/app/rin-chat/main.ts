#!/usr/bin/env node
import { startChatBridge } from "../../core/chat/main.js";

async function main() {
  await startChatBridge();
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_app_chat_failed"));
  process.exit(1);
});
