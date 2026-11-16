/**
 * `@kh/api-client`：与框架无关的强类型 API 客户端。
 * 不依赖 React / Next.js，可在 Node、Worker、浏览器中复用。
 */
export {
  ApiClient,
  ApiError,
  ERROR_CODE_TEXT,
  buildQuery,
  createApiClient,
  toApiError,
  unwrap,
} from './http';
export type { ApiClientConfig, ErrorCode, QueryParams, QueryValue, RequestOptions, TokenProvider } from './http';

export { consumeChatStream, iterateSse, normalizeCitation, toChatStreamEvent } from './sse';
export type { RawSseEvent } from './sse';

export {
  SESSION_STORAGE_KEY,
  createLocalStorageSession,
  createMemorySession,
  sessionFromLogin,
} from './session';
export type { SessionStorage, StoredSession } from './session';

export * from './types';

export { createAuthApi } from './endpoints/auth';
export type { AuthApi } from './endpoints/auth';
export { createKbApi } from './endpoints/kbs';
export type { KbApi, KbMemberView } from './endpoints/kbs';
export { createDocumentApi } from './endpoints/documents';
export type { DocumentApi } from './endpoints/documents';
export { createIndexJobApi } from './endpoints/indexJobs';
export type { IndexJobApi } from './endpoints/indexJobs';
export { createRetrievalProfileApi } from './endpoints/retrievalProfiles';
export type { RetrievalProfileApi } from './endpoints/retrievalProfiles';
export { createChatApi } from './endpoints/chat';
export type { ChatApi, StreamHandlers } from './endpoints/chat';
export { createIamApi } from './endpoints/iam';
export type { IamApi } from './endpoints/iam';
export { createMenuApi } from './endpoints/menus';
export type { MenuApi, MenuItemView, CreateMenuItemRequest, UpdateMenuItemRequest } from './endpoints/menus';
export { createOpsApi } from './endpoints/ops';
export type { OpsApi } from './endpoints/ops';
export { createEvalApi } from './endpoints/eval';
export type { EvalApi } from './endpoints/eval';
export { createGraphApi } from './endpoints/graph';
export type { GraphApi, GraphQueryResult } from './endpoints/graph';
export { createDatasourceApi } from './endpoints/datasources';
export type { DatasourceApi } from './endpoints/datasources';
export { createIntegrationApi } from './endpoints/integrations';
export type {
  IntegrationApi,
  PlatformAgent,
  PlatformAgentDetail,
  PlatformGatewayCredential,
  PlatformGatewayKey,
  PlatformGatewayModel,
  PlatformObservation,
  PlatformPromptDetail,
  PlatformPromptRow,
  PlatformSkill,
  PlatformVersionRow,
  AdminConversationMessage,
  AdminConversationRow,
} from './endpoints/integrations';

import { ApiClient, createApiClient } from './http';
import type { ApiClientConfig } from './http';
import { createAuthApi } from './endpoints/auth';
import { createKbApi } from './endpoints/kbs';
import { createDocumentApi } from './endpoints/documents';
import { createIndexJobApi } from './endpoints/indexJobs';
import { createRetrievalProfileApi } from './endpoints/retrievalProfiles';
import { createChatApi } from './endpoints/chat';
import { createIamApi } from './endpoints/iam';
import { createMenuApi } from './endpoints/menus';
import { createOpsApi } from './endpoints/ops';
import { createEvalApi } from './endpoints/eval';
import { createGraphApi } from './endpoints/graph';
import { createDatasourceApi } from './endpoints/datasources';
import { createIntegrationApi } from './endpoints/integrations';

export interface ApiBundle {
  client: ApiClient;
  auth: ReturnType<typeof createAuthApi>;
  kbs: ReturnType<typeof createKbApi>;
  documents: ReturnType<typeof createDocumentApi>;
  indexJobs: ReturnType<typeof createIndexJobApi>;
  retrievalProfiles: ReturnType<typeof createRetrievalProfileApi>;
  chat: ReturnType<typeof createChatApi>;
  iam: ReturnType<typeof createIamApi>;
  menus: ReturnType<typeof createMenuApi>;
  ops: ReturnType<typeof createOpsApi>;
  evalApi: ReturnType<typeof createEvalApi>;
  graph: ReturnType<typeof createGraphApi>;
  datasources: ReturnType<typeof createDatasourceApi>;
  integrations: ReturnType<typeof createIntegrationApi>;
}

/** 一次组装全部端点，两个应用共用 */
export function createApi(config: ApiClientConfig = {}): ApiBundle {
  const client = createApiClient(config);
  return {
    client,
    auth: createAuthApi(client),
    kbs: createKbApi(client),
    documents: createDocumentApi(client),
    indexJobs: createIndexJobApi(client),
    retrievalProfiles: createRetrievalProfileApi(client),
    chat: createChatApi(client),
    iam: createIamApi(client),
    menus: createMenuApi(client),
    ops: createOpsApi(client),
    evalApi: createEvalApi(client),
    graph: createGraphApi(client),
    datasources: createDatasourceApi(client),
    integrations: createIntegrationApi(client),
  };
}
