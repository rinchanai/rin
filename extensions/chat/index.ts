import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import getChatMessageExtension from "./get-message.js";
import sendChatMessageExtension from "./send-message.js";

export default function chatExtension(pi: ExtensionAPI) {
  sendChatMessageExtension(pi);
  getChatMessageExtension(pi);
}
