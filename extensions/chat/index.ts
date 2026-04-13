import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import getChatMessageExtension from "./get-message.js";
import listChatLogExtension from "./list-log.js";
import saveChatUserTrustExtension from "./save-user-trust.js";
import sendChatMessageExtension from "./send-message.js";

export default function chatExtension(pi: ExtensionAPI) {
  sendChatMessageExtension(pi);
  getChatMessageExtension(pi);
  listChatLogExtension(pi);
  saveChatUserTrustExtension(pi);
}
