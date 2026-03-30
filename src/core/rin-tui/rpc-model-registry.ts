import { RinDaemonFrontendClient } from './rpc-client.js'
import { createAuthStorageProxy } from './rpc-auth.js'

export function createModelRegistry(client: RinDaemonFrontendClient) {
  const state = { models: [] as any[], error: undefined as string | undefined }
  const authStorage = createAuthStorageProxy(client)
  return {
    authStorage,
    refresh() { void this.sync() },
    getError() { return state.error },
    getAvailable() { return [...state.models] },
    find(provider: string, modelId: string) {
      return state.models.find((model) => model.provider === provider && model.id === modelId)
    },
    isUsingOAuth(model: any) { return authStorage.get(model?.provider)?.type === 'oauth' },
    async sync() {
      try {
        const [modelsResponse, oauthResponse]: any = await Promise.all([
          client.send({ type: 'get_available_models' }),
          client.send({ type: 'get_oauth_state' }),
        ])
        const modelsData: any = modelsResponse && modelsResponse.success === true ? modelsResponse.data : null
        state.models = Array.isArray(modelsData?.models) ? modelsData.models : []
        state.error = undefined
        const oauthData: any = oauthResponse && oauthResponse.success === true ? oauthResponse.data : null
        authStorage.applyState(oauthData)
      } catch (error: any) {
        state.error = String(error?.message || error || 'rin_model_registry_failed')
      }
    },
  }
}
