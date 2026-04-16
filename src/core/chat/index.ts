import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import chatBridgeExtension from "./chat-bridge.js";
import configureChatBridgeCommandExtension from "./configure-chat-bridge.js";
import getChatMessageExtension from "./get-chat-message.js";
import listChatLogExtension from "./list-chat-log.js";
import saveChatUserTrustExtension from "./save-chat-user-trust.js";

export default function chatExtension(pi: ExtensionAPI) {
  configureChatBridgeCommandExtension(pi);
  chatBridgeExtension(pi);
  getChatMessageExtension(pi);
  listChatLogExtension(pi);
  saveChatUserTrustExtension(pi);
}
