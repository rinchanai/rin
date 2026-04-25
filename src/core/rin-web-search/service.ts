import { dataRootForState } from "./paths.js";
import {
  DIRECT_WEB_SEARCH_PROVIDERS,
  searchWeb as performWebSearch,
  type WebSearchRequest,
  type WebSearchResponse,
} from "./query.js";

async function searchWeb({
  q,
  limit,
  domains,
  freshness,
  language,
}: WebSearchRequest): Promise<WebSearchResponse> {
  return await performWebSearch({
    q,
    limit,
    domains,
    freshness,
    language,
  });
}

function getWebSearchStatus(stateRoot: string) {
  return {
    root: dataRootForState(stateRoot),
    runtime: {
      ready: true,
      mode: "direct",
      providerCount: DIRECT_WEB_SEARCH_PROVIDERS.length,
      providers: [...DIRECT_WEB_SEARCH_PROVIDERS],
    },
    instances: [],
  };
}

export {
  DIRECT_WEB_SEARCH_PROVIDERS,
  getWebSearchStatus,
  searchWeb,
  type WebSearchRequest,
  type WebSearchResponse,
};
