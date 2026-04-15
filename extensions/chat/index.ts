import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import chatBridgeExtension from "./bridge.js";
import configureChatBridgeCommandExtension from "./configure-chat-bridge.js";
import getChatMessageExtension from "./get-message.js";
import listChatLogExtension from "./list-log.js";
import saveChatUserTrustExtension from "./save-user-trust.js";

export default function chatExtension(pi: ExtensionAPI) {
  configureChatBridgeCommandExtension(pi);
  chatBridgeExtension(pi);
  getChatMessageExtension(pi);
  listChatLogExtension(pi);
  saveChatUserTrustExtension(pi);
}
