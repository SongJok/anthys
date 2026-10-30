import type {
  AuditLog,
  DashboardPayload,
  DefaultGroupPolicy,
  DingTalkConfig,
  GroupPolicy,
  KnownGroup,
  LLMConfig,
  LlmTestResult,
  LoopPolicy,
  McpAccessPolicy,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  StreamStatus,
  TracePage,
} from './types';

const TOKEN_KEY = 'dingtalk-agent-admin-token';
const BASE = '/api/v1/admin';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `请求失败 (${response.status})`);
  }
  return payload as T;
}

export const api = {
  dashboard: () => request<DashboardPayload>('/dashboard'),

  dingtalk: () =>
    request<{ config: DingTalkConfig; stream: StreamStatus | null }>(
      '/config/dingtalk',
    ),
  updateDingtalk: (
    body: Partial<DingTalkConfig> & { clientSecret?: string },
  ) =>
    request<{ config: DingTalkConfig; stream: StreamStatus | null }>(
      '/config/dingtalk',
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  testCard: (staffId?: string) =>
    request<{ ok: boolean; error?: string }>('/config/dingtalk/test-card', {
      method: 'POST',
      body: JSON.stringify({ staffId }),
    }),

  llm: () =>
    request<{ llm: LLMConfig; loopPolicy: LoopPolicy; persona: LLMConfig['persona'] }>(
      '/config/llm',
    ),
  updateLlm: (body: {
    provider?: LLMConfig['provider'];
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    enableNativeReasoning?: boolean;
    persona?: Partial<LLMConfig['persona']>;
    loop?: Partial<LoopPolicy>;
  }) =>
    request<{ llm: LLMConfig; loopPolicy: LoopPolicy; hotReloaded: boolean }>(
      '/config/llm',
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  testLlm: (question: string, systemPrompt?: string) =>
    request<{ result: LlmTestResult }>('/config/llm/test', {
      method: 'POST',
      body: JSON.stringify({ question, systemPrompt }),
    }),

  mcpServers: () =>
    request<{ servers: McpServerConfig[]; status: McpServerStatus[] }>(
      '/mcp-servers',
    ),
  createMcp: (server: McpServerConfig) =>
    request<{ server: McpServerConfig; servers: McpServerConfig[] }>(
      '/mcp-servers',
      { method: 'POST', body: JSON.stringify(server) },
    ),
  updateMcp: (id: string, server: Partial<McpServerConfig>) =>
    request<{ server: McpServerConfig; servers: McpServerConfig[] }>(
      `/mcp-servers/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(server) },
    ),
  deleteMcp: (id: string) =>
    request<{ servers: McpServerConfig[] }>(
      `/mcp-servers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  testMcp: (id: string) =>
    request<{ result: McpTestResult }>(
      `/mcp-servers/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),
  accessPolicies: () =>
    request<{ policies: McpAccessPolicy[] }>('/mcp-access-policies'),
  updateAccessPolicies: (policies: McpAccessPolicy[]) =>
    request<{ policies: McpAccessPolicy[] }>('/mcp-access-policies', {
      method: 'PUT',
      body: JSON.stringify({ policies }),
    }),

  groups: () =>
    request<{ defaults: DefaultGroupPolicy; groups: KnownGroup[] }>('/groups'),
  groupPolicy: (conversationId: string) =>
    request<{ policy: GroupPolicy }>(
      `/groups/${encodeURIComponent(conversationId)}/policy`,
    ),
  updateGroupPolicy: (
    conversationId: string,
    body: Partial<Omit<GroupPolicy, 'conversationId'>>,
  ) =>
    request<{ policy: GroupPolicy }>(
      `/groups/${encodeURIComponent(conversationId)}/policy`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  emergencyMute: (conversationId?: string) =>
    request<{ muted: string[]; defaultMuted: boolean }>(
      '/groups/emergency-mute',
      { method: 'POST', body: JSON.stringify({ conversationId }) },
    ),

  traces: (params: {
    page: number;
    pageSize: number;
    conversationId?: string;
    sinceMs?: number;
  }) => {
    const search = new URLSearchParams({
      page: String(params.page),
      pageSize: String(params.pageSize),
    });
    if (params.conversationId) search.set('conversationId', params.conversationId);
    if (params.sinceMs !== undefined) search.set('sinceMs', String(params.sinceMs));
    return request<TracePage>(`/traces?${search.toString()}`);
  },
  auditLogs: (limit = 50) =>
    request<{ logs: AuditLog[] }>(`/audit-logs?limit=${limit}`),
};
