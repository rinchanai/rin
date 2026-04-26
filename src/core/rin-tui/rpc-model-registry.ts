import type { RpcFrontendClient } from "./frontend-surface.js";
import { createAuthStorageProxy } from "./rpc-auth.js";

export function createModelRegistry(client: RpcFrontendClient) {
  const state = {
    allModels: [] as any[],
    availableModels: [] as any[],
    error: undefined as string | undefined,
  };
  const authStorage = createAuthStorageProxy(client);
  return {
    authStorage,
    refresh() {
      void this.sync();
    },
    getError() {
      return state.error;
    },
    getAll() {
      return [...state.allModels];
    },
    getAvailable() {
      return [...state.availableModels];
    },
    find(provider: string, modelId: string) {
      return state.allModels.find(
        (model) => model.provider === provider && model.id === modelId,
      );
    },
    isUsingOAuth(model: any) {
      return authStorage.get(model?.provider)?.type === "oauth";
    },
    async sync() {
      try {
        const [allModelsResponse, modelsResponse, oauthResponse]: any =
          await Promise.all([
            client.send({ type: "get_all_models" }),
            client.send({ type: "get_available_models" }),
            client.send({ type: "get_oauth_state" }),
          ]);
        const allModelsData: any =
          allModelsResponse && allModelsResponse.success === true
            ? allModelsResponse.data
            : null;
        const modelsData: any =
          modelsResponse && modelsResponse.success === true
            ? modelsResponse.data
            : null;
        state.allModels = Array.isArray(allModelsData?.models)
          ? allModelsData.models
          : [];
        state.availableModels = Array.isArray(modelsData?.models)
          ? modelsData.models
          : [];
        state.error = undefined;
        const oauthData: any =
          oauthResponse && oauthResponse.success === true
            ? oauthResponse.data
            : null;
        authStorage.applyState(oauthData);
      } catch (error: any) {
        state.error = String(
          error?.message || error || "rin_model_registry_failed",
        );
      }
    },
  };
}
