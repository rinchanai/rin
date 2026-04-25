import type { BuiltinModuleApi } from "../builtins/host.js";

import chatBridgeModule from "./chat-bridge.js";
import configureChatBridgeCommandModule from "./configure-chat-bridge.js";
import getChatMessageExtension from "./get-chat-message.js";
import listChatLogExtension from "./list-chat-log.js";
import saveChatUserTrustModule from "./save-chat-user-trust.js";

export default function chatModule(pi: BuiltinModuleApi) {
  configureChatBridgeCommandModule(pi);
  chatBridgeModule(pi);
  getChatMessageExtension(pi);
  listChatLogExtension(pi);
  saveChatUserTrustModule(pi);
}
