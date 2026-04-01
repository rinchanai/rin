import { RinDaemonFrontendClient } from "./rpc-client.js";

export function createAuthStorageProxy(client: RinDaemonFrontendClient) {
  const state = {
    credentials: {} as Record<string, { type: string } | undefined>,
    providers: [] as Array<{
      id: string;
      name: string;
      usesCallbackServer?: boolean;
    }>,
    logins: new Map<
      string,
      {
        onAuth?: (info: { url: string; instructions?: string }) => void;
        onPrompt?: (prompt: {
          message: string;
          placeholder?: string;
        }) => Promise<string>;
        onProgress?: (message: string) => void;
        onManualCodeInput?: () => Promise<string>;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    >(),
  };

  const applyState = (data: any) => {
    state.credentials =
      data && typeof data.credentials === "object" && data.credentials
        ? data.credentials
        : {};
    state.providers = Array.isArray(data?.providers) ? data.providers : [];
  };

  const handleEvent = (payload: any) => {
    if (!payload || payload.type !== "oauth_login_event") return;
    const login = state.logins.get(String(payload.loginId || ""));
    if (!login) return;

    if (payload.event === "auth") {
      login.onAuth?.({
        url: String(payload.url || ""),
        instructions:
          typeof payload.instructions === "string"
            ? payload.instructions
            : undefined,
      });
      return;
    }
    if (payload.event === "progress") {
      login.onProgress?.(String(payload.message || ""));
      return;
    }
    if (payload.event === "prompt") {
      Promise.resolve(
        login.onPrompt?.({
          message: String(payload.message || ""),
          placeholder:
            typeof payload.placeholder === "string"
              ? payload.placeholder
              : undefined,
        }) ?? "",
      )
        .then((value) =>
          client
            .send({
              type: "oauth_login_respond",
              loginId: payload.loginId,
              requestId: payload.requestId,
              value,
            })
            .catch(() => {}),
        )
        .catch(() =>
          client
            .send({ type: "oauth_login_cancel", loginId: payload.loginId })
            .catch(() => {}),
        );
      return;
    }
    if (payload.event === "manual_code") {
      Promise.resolve(login.onManualCodeInput?.() ?? "")
        .then((value) =>
          client
            .send({
              type: "oauth_login_respond",
              loginId: payload.loginId,
              requestId: payload.requestId,
              value,
            })
            .catch(() => {}),
        )
        .catch(() =>
          client
            .send({ type: "oauth_login_cancel", loginId: payload.loginId })
            .catch(() => {}),
        );
      return;
    }
    if (payload.event === "complete") {
      state.logins.delete(String(payload.loginId || ""));
      if (payload.state) applyState(payload.state);
      if (payload.success === true) login.resolve();
      else
        login.reject(new Error(String(payload.error || "oauth_login_failed")));
    }
  };

  return {
    list: () => Object.keys(state.credentials),
    get: (providerId: string) => state.credentials[providerId],
    getOAuthProviders: () => [...state.providers],
    applyState,
    async sync() {
      const response: any = await client.send({ type: "get_oauth_state" });
      const data: any =
        response && response.success === true ? response.data : null;
      applyState(data);
    },
    logout(providerId: string) {
      delete state.credentials[providerId];
      void client
        .send({ type: "oauth_logout", providerId })
        .then((response: any) => {
          if (response?.success === true) applyState(response.data);
        })
        .catch(() => {});
    },
    async login(providerId: string, callbacks: any = {}) {
      const response: any = await client.send({
        type: "oauth_login_start",
        providerId,
      });
      if (!response || response.success !== true || !response.data?.loginId) {
        throw new Error(String(response?.error || "oauth_login_failed"));
      }
      const loginId = String(response.data.loginId);
      await new Promise<void>((resolve, reject) => {
        state.logins.set(loginId, {
          onAuth: callbacks.onAuth,
          onPrompt: callbacks.onPrompt,
          onProgress: callbacks.onProgress,
          onManualCodeInput: callbacks.onManualCodeInput,
          resolve,
          reject,
        });
        if (callbacks.signal) {
          const abortHandler = () => {
            void client
              .send({ type: "oauth_login_cancel", loginId })
              .catch(() => {});
            state.logins.delete(loginId);
            reject(new Error("Login cancelled"));
          };
          if (callbacks.signal.aborted) abortHandler();
          else
            callbacks.signal.addEventListener("abort", abortHandler, {
              once: true,
            });
        }
      });
    },
    handleEvent,
  };
}
