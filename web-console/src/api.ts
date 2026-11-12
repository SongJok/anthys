import type {
  AuditLog,
  CleanupResult,
  DashboardPayload,
  DefaultGroupPolicy,
  DeletionResult,
  DingTalkConfig,
  GlossaryPromptPreview,
  GlossaryCandidate,
  GlossaryCandidateStats,
  GlossaryCandidateStatus,
  GlossarySensitivity,
  GlossaryStats,
  GlossaryTerm,
  GlossaryTimeliness,
  GlossaryValidationReport,
  GithubAdminStatus,
  GithubConnectionTestResult,
  GroupDirectoryEntry,
  GroupDirectorySyncResult,
  GroupGoalRecord,
  GroupGoalStatus,
  GroupMemorySharing,
  GroupModelRoute,
  GroupModelProvider,
  GroupPolicy,
  GroupTaskRecord,
  GroupTaskStatus,
  GroupWorkspaceSnapshot,
  HandbookSectionPatch,
  KnownGroup,
  LLMConfig,
  LlmTestResult,
  LoopPolicy,
  McpAccessPolicy,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  PersonIdentity,
  PersonIdentityBindResult,
  PersonMemoryConsent,
  PersonPreferences,
  PersonaProfile,
  PersonaScope,
  PreferenceLanguage,
  ReplyLength,
  PluginAdminView,
  PluginPackagePreview,
  PluginValidationIssue,
  PluginVersionRecord,
  ProjectAdminEntry,
  ProjectHandbookRecord,
  ProjectHandbookResult,
  ProjectManualEntry,
  ProjectManualEntryInput,
  ProjectRecord,
  ProjectSearchResult,
  ProjectSnapshot,
  ProjectStatus,
  ProjectSyncJob,
  RetentionPolicy,
  RetentionStats,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskUpdate,
  SystemLoopStatus,
  SemanticMemory,
  SemanticMemoryKind,
  SemanticMemoryPage,
  SemanticMemorySensitivity,
  SemanticMemoryScope,
  SemanticMemoryStatus,
  SkillAdminView,
  SkillDraftInput,
  SkillModuleSummary,
  SkillPreviewResult,
  SkillResourceReadResult,
  SkillResourceInfo,
  SkillUsageSummary,
  SkillValidationResult,
  StreamStatus,
  TracePage,
  UsageSummary,
  WhitelistEntry,
  WhitelistPage,
  WhitelistStats,
  WhitelistStatus,
  WhitelistSyncResult,
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

async function parsePayload<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `请求失败 (${response.status})`);
  }
  return payload as T;
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
  return parsePayload<T>(response);
}

async function postForm<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  return parsePayload<T>(response);
}

export const api = {
  dashboard: () => request<DashboardPayload>('/dashboard'),
  usage: (days = 1) =>
    request<{ summary: UsageSummary }>(`/usage?days=${days}`),

  scheduledTasks: () => request<{ tasks: ScheduledTask[] }>('/scheduled-tasks'),
  createScheduledTask: (input: ScheduledTaskInput) =>
    request<{ task: ScheduledTask }>('/scheduled-tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateScheduledTask: (id: string, input: ScheduledTaskUpdate) =>
    request<{ task: ScheduledTask }>(
      `/scheduled-tasks/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  deleteScheduledTask: (id: string) =>
    request<{ removed: boolean }>(
      `/scheduled-tasks/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  runScheduledTask: (id: string) =>
    request<{ ok: boolean }>(
      `/scheduled-tasks/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),
  systemLoops: () =>
    request<{ loops: SystemLoopStatus[] }>('/scheduled-tasks/system-loops'),

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
  groupDirectory: (params?: {
    query?: string;
    onlyWithBots?: boolean;
    botName?: string;
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params?.query) search.set('query', params.query);
    if (params?.onlyWithBots) search.set('onlyWithBots', '1');
    if (params?.botName) search.set('botName', params.botName);
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<{ items: GroupDirectoryEntry[]; total: number }>(
      `/groups/directory${qs ? `?${qs}` : ''}`,
    );
  },
  syncGroupDirectory: (includeBots = true) =>
    request<{ result: GroupDirectorySyncResult }>('/groups/sync-directory', {
      method: 'POST',
      body: JSON.stringify({ includeBots }),
    }),
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

  personas: (scope?: PersonaScope) =>
    request<{ profiles: PersonaProfile[] }>(
      `/personas${scope ? `?scope=${scope}` : ''}`,
    ),
  savePersona: (
    scope: PersonaScope,
    subjectKey: string,
    body: Partial<
      Pick<
        PersonaProfile,
        'name' | 'rolePrompt' | 'speakingStyle' | 'enabled'
      >
    >,
  ) =>
    request<{ profile: PersonaProfile }>(
      `/personas/${scope}/${encodeURIComponent(subjectKey)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deletePersona: (scope: PersonaScope, subjectKey: string) =>
    request<{ ok: boolean; removed: boolean }>(
      `/personas/${scope}/${encodeURIComponent(subjectKey)}`,
      { method: 'DELETE' },
    ),

  identities: (query?: string) =>
    request<{ people: PersonIdentity[] }>(
      `/identities${query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''}`,
    ),
  bindIdentity: (body: {
    alias: string;
    source?: 'staff' | 'open' | 'external' | 'manual';
    staffId?: string;
    personKey?: string;
    displayName?: string;
    mergeMemories?: boolean;
  }) =>
    request<PersonIdentityBindResult & { ok: boolean }>('/identities/bind', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  groupWorkspace: (conversationId: string) =>
    request<GroupWorkspaceSnapshot & { ok: boolean }>(
      `/groups/${encodeURIComponent(conversationId)}/workspace`,
    ),
  updateGroupWorkspace: (
    conversationId: string,
    body: { title?: string; purpose?: string; responsibilities?: string[] },
  ) =>
    request<{ workspace: GroupWorkspaceSnapshot['workspace'] }>(
      `/groups/${encodeURIComponent(conversationId)}/workspace`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  createGroupGoal: (
    conversationId: string,
    body: {
      title: string;
      detail?: string;
      progress?: number;
      ownerName?: string;
      dueAt?: number | null;
    },
  ) =>
    request<{ goal: GroupGoalRecord }>(
      `/groups/${encodeURIComponent(conversationId)}/goals`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateGroupGoal: (
    conversationId: string,
    goalId: string,
    body: {
      title?: string;
      detail?: string;
      status?: GroupGoalStatus;
      progress?: number;
      ownerName?: string;
      dueAt?: number | null;
    },
  ) =>
    request<{ goal: GroupGoalRecord }>(
      `/groups/${encodeURIComponent(conversationId)}/goals/${encodeURIComponent(goalId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deleteGroupGoal: (conversationId: string, goalId: string) =>
    request<{ ok: boolean; removed: boolean }>(
      `/groups/${encodeURIComponent(conversationId)}/goals/${encodeURIComponent(goalId)}`,
      { method: 'DELETE' },
    ),
  createGroupTask: (
    conversationId: string,
    body: {
      title: string;
      detail?: string;
      goalId?: string | null;
      assigneeName?: string;
      dueAt?: number | null;
    },
  ) =>
    request<{ task: GroupTaskRecord }>(
      `/groups/${encodeURIComponent(conversationId)}/tasks`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateGroupTask: (
    conversationId: string,
    taskId: string,
    body: {
      title?: string;
      detail?: string;
      status?: GroupTaskStatus;
      goalId?: string | null;
      assigneeName?: string;
      dueAt?: number | null;
    },
  ) =>
    request<{ task: GroupTaskRecord }>(
      `/groups/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deleteGroupTask: (conversationId: string, taskId: string) =>
    request<{ ok: boolean; removed: boolean }>(
      `/groups/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' },
    ),

  groupModelRoute: (conversationId: string) =>
    request<{
      route: GroupModelRoute | null;
      apiKeyConfigured?: boolean;
    }>(`/groups/${encodeURIComponent(conversationId)}/model-route`),
  updateGroupModelRoute: (
    conversationId: string,
    body: {
      enabled?: boolean;
      provider?: GroupModelProvider;
      baseUrl?: string;
      apiKeyEnv?: string;
      model?: string;
      temperature?: number | null;
      thinking?: GroupModelRoute['thinking'];
      maxTokens?: number | null;
    },
  ) =>
    request<{ route: GroupModelRoute; apiKeyConfigured: boolean }>(
      `/groups/${encodeURIComponent(conversationId)}/model-route`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  deleteGroupModelRoute: (conversationId: string) =>
    request<{ ok: boolean; removed: boolean }>(
      `/groups/${encodeURIComponent(conversationId)}/model-route`,
      { method: 'DELETE' },
    ),

  personPreferences: (personKey?: string) =>
    request<{ preferences: PersonPreferences | PersonPreferences[] }>(
      `/person-settings/preferences${
        personKey?.trim()
          ? `?personKey=${encodeURIComponent(personKey.trim())}`
          : ''
      }`,
    ),
  updatePersonPreferences: (body: {
    personKey: string;
    replyLength?: ReplyLength;
    language?: PreferenceLanguage;
    addressAs?: string;
    extraInstructions?: string;
    enabled?: boolean;
  }) =>
    request<{ preferences: PersonPreferences }>(
      '/person-settings/preferences',
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  personConsents: (personKey?: string) =>
    request<{ consent?: PersonMemoryConsent; consents?: PersonMemoryConsent[] }>(
      `/person-settings/consents${
        personKey?.trim()
          ? `?personKey=${encodeURIComponent(personKey.trim())}`
          : ''
      }`,
    ),
  updatePersonConsent: (body: {
    personKey: string;
    groupSharing?: GroupMemorySharing;
    allowedConversationIds?: string[];
  }) =>
    request<{ consent: PersonMemoryConsent }>('/person-settings/consents', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  memories: (params: {
    scope?: SemanticMemoryScope;
    subjectKey?: string;
    kind?: SemanticMemoryKind;
    status?: SemanticMemoryStatus;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const suffix = search.toString();
    return request<SemanticMemoryPage>(`/memories${suffix ? `?${suffix}` : ''}`);
  },
  updateMemory: (
    id: string,
    body: {
      content?: string;
      keywords?: string[];
      shareableInGroup?: boolean;
      sensitivity?: SemanticMemorySensitivity;
      status?: SemanticMemoryStatus;
      confidence?: number;
      expiresAt?: number | null;
    },
  ) =>
    request<{ memory: SemanticMemory }>(
      `/memories/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  deleteMemory: (id: string) =>
    request<{ ok: boolean; removed: boolean }>(
      `/memories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
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

  createChatTicket: () =>
    request<{ ticket: string; expiresAt: number }>('/chat/tickets', {
      method: 'POST',
    }),

  governance: () => request<RetentionStats>('/governance'),
  updateRetention: (body: Partial<RetentionPolicy>) =>
    request<{ policy: RetentionPolicy }>('/governance/retention', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  cleanupData: (dryRun: boolean) =>
    request<{ result: CleanupResult }>('/governance/cleanup', {
      method: 'POST',
      body: JSON.stringify({ dryRun }),
    }),
  deleteConversationData: (conversationId: string) =>
    request<{ result: DeletionResult }>('/governance/delete-conversation', {
      method: 'POST',
      body: JSON.stringify({ conversationId, confirm: true }),
    }),
  deleteUserData: (staffId: string) =>
    request<{ result: DeletionResult }>('/governance/delete-user', {
      method: 'POST',
      body: JSON.stringify({ staffId, confirm: true }),
    }),

  glossary: (params: {
    query?: string;
    department?: string;
    timeliness?: GlossaryTimeliness;
    sensitivity?: GlossarySensitivity;
    onlyInjected?: boolean;
    sort?: 'updated' | 'hits' | 'priority';
    limit?: number;
    offset?: number;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.query) search.set('query', params.query);
    if (params.department) search.set('department', params.department);
    if (params.timeliness) search.set('timeliness', params.timeliness);
    if (params.sensitivity) search.set('sensitivity', params.sensitivity);
    if (params.onlyInjected) search.set('onlyInjected', 'true');
    if (params.sort) search.set('sort', params.sort);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const suffix = search.toString();
    return request<{ terms: GlossaryTerm[]; total: number }>(
      `/glossary${suffix ? `?${suffix}` : ''}`,
    );
  },
  glossaryStats: () => request<{ stats: GlossaryStats }>('/glossary/stats'),
  glossaryValidate: () =>
    request<{ report: GlossaryValidationReport }>('/glossary/validate'),
  glossaryPromptPreview: (limit?: number) =>
    request<GlossaryPromptPreview>(
      `/glossary/prompt-preview${limit ? `?limit=${limit}` : ''}`,
    ),
  createGlossary: (body: Partial<GlossaryTerm> & { standardName: string; definition: string }) =>
    request<{ term: GlossaryTerm }>('/glossary', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateGlossary: (id: string, body: Partial<GlossaryTerm>) =>
    request<{ term: GlossaryTerm }>(`/glossary/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteGlossary: (id: string) =>
    request<{ removed: boolean }>(`/glossary/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  glossaryCandidates: (params: {
    status?: GlossaryCandidateStatus;
    limit?: number;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const suffix = search.toString();
    return request<{ candidates: GlossaryCandidate[] }>(
      `/glossary-candidates${suffix ? `?${suffix}` : ''}`,
    );
  },
  glossaryCandidateStats: () =>
    request<{ stats: GlossaryCandidateStats }>('/glossary-candidates/stats'),
  approveGlossaryCandidate: (id: string, reviewNote?: string) =>
    request<{ candidate: GlossaryCandidate; term: GlossaryTerm }>(
      `/glossary-candidates/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(reviewNote !== undefined ? { reviewNote } : {}),
      },
    ),
  rejectGlossaryCandidate: (id: string, reviewNote?: string) =>
    request<{ candidate: GlossaryCandidate }>(
      `/glossary-candidates/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify(reviewNote !== undefined ? { reviewNote } : {}),
      },
    ),

  skills: (
    params: {
      query?: string;
      source?: string;
      module?: string;
      enabled?: boolean;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.query) search.set('query', params.query);
    if (params.source) search.set('source', params.source);
    if (params.module) search.set('module', params.module);
    if (params.enabled !== undefined) search.set('enabled', String(params.enabled));
    const suffix = search.toString();
    return request<{ skills: SkillAdminView[]; total: number }>(
      `/skills${suffix ? `?${suffix}` : ''}`,
    );
  },
  skillModules: () =>
    request<{ modules: SkillModuleSummary[]; total: number }>('/skills/modules'),
  skill: (id: string) =>
    request<{ skill: SkillAdminView }>(`/skills/${encodeURIComponent(id)}`),
  createSkill: (body: SkillDraftInput) =>
    request<{ skill: SkillAdminView }>('/skills', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSkill: (id: string, body: SkillDraftInput) =>
    request<{ skill: SkillAdminView }>(`/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteSkill: (id: string) =>
    request<{ ok: boolean }>(`/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  setSkillEnabled: (id: string, enabled: boolean) =>
    request<{ skill: SkillAdminView }>(
      `/skills/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
  reloadSkills: () =>
    request<{ loaded: number; errors: string[] }>('/skills/reload', {
      method: 'POST',
    }),
  validateSkill: (body: SkillDraftInput) =>
    request<{ result: SkillValidationResult }>('/skills/validate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  previewSkills: (body: {
    query: string;
    conversationType?: '1' | '2';
    isAdmin?: boolean;
    projectId?: string;
    limit?: number;
  }) =>
    request<SkillPreviewResult>('/skills/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  skillUsage: (days = 7) =>
    request<{ days: number; usage: Record<string, SkillUsageSummary> }>(
      `/skills/usage?days=${days}`,
    ),
  readSkillResource: (id: string, resourcePath: string) =>
    request<{ resource: SkillResourceReadResult }>(
      `/skills/${encodeURIComponent(id)}/resource?path=${encodeURIComponent(resourcePath)}`,
    ),
  writeSkillResource: (id: string, path: string, content: string) =>
    request<{ resource: SkillResourceInfo }>(
      `/skills/${encodeURIComponent(id)}/resource`,
      { method: 'PUT', body: JSON.stringify({ path, content }) },
    ),
  deleteSkillResource: (id: string, resourcePath: string) =>
    request<{ ok: boolean }>(
      `/skills/${encodeURIComponent(id)}/resource?path=${encodeURIComponent(resourcePath)}`,
      { method: 'DELETE' },
    ),

  plugins: (params: { query?: string; status?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.query) search.set('query', params.query);
    if (params.status) search.set('status', params.status);
    const suffix = search.toString();
    return request<{ plugins: PluginAdminView[]; total: number }>(
      `/plugins${suffix ? `?${suffix}` : ''}`,
    );
  },
  plugin: (id: string) =>
    request<{ plugin: PluginAdminView }>(`/plugins/${encodeURIComponent(id)}`),
  pluginVersions: (id: string) =>
    request<{ versions: PluginVersionRecord[] }>(
      `/plugins/${encodeURIComponent(id)}/versions`,
    ),
  validatePlugin: (body: { path?: string; dir?: string }) =>
    request<{ preview: PluginPackagePreview }>('/plugins/validate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  validatePluginFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postForm<{ preview: PluginPackagePreview }>('/plugins/validate', form);
  },
  uploadPlugin: (
    file: File,
    options: { force?: boolean; allowMissingSecrets?: boolean; mode?: 'install' | 'upgrade'; id?: string },
  ) => {
    const form = new FormData();
    form.append('file', file);
    if (options.force !== undefined) form.append('force', String(options.force));
    if (options.allowMissingSecrets !== undefined) {
      form.append('allowMissingSecrets', String(options.allowMissingSecrets));
    }
    const path =
      options.mode === 'upgrade' && options.id
        ? `/plugins/${encodeURIComponent(options.id)}/upgrade`
        : '/plugins/install';
    return postForm<{ plugin: PluginAdminView; warnings: PluginValidationIssue[] }>(
      path,
      form,
    );
  },
  installPluginPath: (body: {
    path?: string;
    dir?: string;
    force?: boolean;
    allowMissingSecrets?: boolean;
  }) =>
    request<{ plugin: PluginAdminView; warnings: PluginValidationIssue[] }>(
      '/plugins/install',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  upgradePluginPath: (
    id: string,
    body: { path?: string; dir?: string; force?: boolean; allowMissingSecrets?: boolean },
  ) =>
    request<{ plugin: PluginAdminView; warnings: PluginValidationIssue[] }>(
      `/plugins/${encodeURIComponent(id)}/upgrade`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  enablePlugin: (id: string) =>
    request<{ plugin: PluginAdminView }>(
      `/plugins/${encodeURIComponent(id)}/enable`,
      { method: 'POST' },
    ),
  disablePlugin: (id: string) =>
    request<{ plugin: PluginAdminView }>(
      `/plugins/${encodeURIComponent(id)}/disable`,
      { method: 'POST' },
    ),
  rollbackPlugin: (id: string, version: string) =>
    request<{ plugin: PluginAdminView }>(
      `/plugins/${encodeURIComponent(id)}/rollback`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  uninstallPlugin: (id: string, deleteFiles = false) =>
    request<{ ok: boolean }>(
      `/plugins/${encodeURIComponent(id)}?deleteFiles=${deleteFiles}`,
      { method: 'DELETE' },
    ),

  projects: (params: { query?: string } = {}) => {
    const suffix = params.query
      ? `?query=${encodeURIComponent(params.query)}`
      : '';
    return request<{ projects: ProjectAdminEntry[]; total: number }>(
      `/projects${suffix}`,
    );
  },
  project: (id: string) =>
    request<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(id)}`),
  createProject: (body: Record<string, unknown>) =>
    request<{ project: ProjectRecord }>('/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProject: (id: string, body: Record<string, unknown>) =>
    request<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  syncProject: (id: string) =>
    request<{ job: ProjectSyncJob }>(
      `/projects/${encodeURIComponent(id)}/sync`,
      { method: 'POST' },
    ),
  projectSyncJobs: (id: string, limit = 20) =>
    request<{ jobs: ProjectSyncJob[] }>(
      `/projects/${encodeURIComponent(id)}/sync-jobs?limit=${limit}`,
    ),
  projectSnapshots: (id: string, limit = 10) =>
    request<{ snapshots: ProjectSnapshot[] }>(
      `/projects/${encodeURIComponent(id)}/snapshots?limit=${limit}`,
    ),
  projectStatus: (id: string) =>
    request<{ status: ProjectStatus }>(
      `/projects/${encodeURIComponent(id)}/status`,
    ),
  searchProject: (id: string, query: string, limit = 10) =>
    request<{ result: ProjectSearchResult }>(
      `/projects/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  projectHandbook: (id: string) =>
    request<{ handbook: ProjectHandbookResult; draft: ProjectHandbookRecord | null }>(
      `/projects/${encodeURIComponent(id)}/handbook`,
    ),
  saveProjectHandbookDraft: (
    id: string,
    input: { version?: number; sections: HandbookSectionPatch[] },
  ) =>
    request<{ handbook: ProjectHandbookRecord }>(
      `/projects/${encodeURIComponent(id)}/handbook`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  projectManualEntries: (id: string) =>
    request<{ entries: ProjectManualEntry[] }>(
      `/projects/${encodeURIComponent(id)}/manual-entries`,
    ),
  projectHandbookVersions: (id: string, limit = 10) =>
    request<{ versions: ProjectHandbookRecord[] }>(
      `/projects/${encodeURIComponent(id)}/handbooks?limit=${limit}`,
    ),
  generateProjectHandbook: (id: string) =>
    request<{ handbook: ProjectHandbookRecord }>(
      `/projects/${encodeURIComponent(id)}/handbook/generate`,
      { method: 'POST' },
    ),
  publishProjectHandbook: (id: string, version?: number) =>
    request<{ handbook: ProjectHandbookRecord }>(
      `/projects/${encodeURIComponent(id)}/handbook/publish`,
      {
        method: 'POST',
        body: JSON.stringify(version ? { version } : {}),
      },
    ),
  createProjectManualEntry: (id: string, input: ProjectManualEntryInput) =>
    request<{ entry: ProjectManualEntry }>(
      `/projects/${encodeURIComponent(id)}/manual-entries`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  updateProjectManualEntry: (
    id: string,
    entryId: string,
    input: Partial<ProjectManualEntryInput>,
  ) =>
    request<{ entry: ProjectManualEntry }>(
      `/projects/${encodeURIComponent(id)}/manual-entries/${encodeURIComponent(entryId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  deleteProjectManualEntry: (id: string, entryId: string) =>
    request<{ ok: boolean }>(
      `/projects/${encodeURIComponent(id)}/manual-entries/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' },
    ),

  githubStatus: () =>
    request<{ ok: boolean; status: GithubAdminStatus }>('/github/status'),
  testGithub: (repo?: string) =>
    request<{ ok: boolean; result: GithubConnectionTestResult }>('/github/test', {
      method: 'POST',
      body: JSON.stringify(repo ? { repo } : {}),
    }),

  whitelist: (params: {
    status?: WhitelistStatus;
    query?: string;
    page?: number;
    pageSize?: number;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.query?.trim()) search.set('query', params.query.trim());
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
    const suffix = search.toString();
    return request<WhitelistPage & { ok: boolean }>(
      `/whitelist${suffix ? `?${suffix}` : ''}`,
    );
  },
  whitelistStats: () =>
    request<{ ok: boolean; stats: WhitelistStats }>('/whitelist/stats'),
  syncWhitelist: () =>
    request<{ ok: boolean; result: WhitelistSyncResult }>('/whitelist/sync', {
      method: 'POST',
    }),
  updateWhitelist: (
    staffId: string,
    body: { status: WhitelistStatus; note?: string },
  ) =>
    request<{ ok: boolean; entry: WhitelistEntry }>(
      `/whitelist/${encodeURIComponent(staffId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  batchWhitelist: (body: { staffIds: string[]; status: WhitelistStatus }) =>
    request<{ ok: boolean; updated: number }>('/whitelist/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/** EventSource 无法携带 Authorize 头，改用一次性票据订阅 SSE */
export function chatStreamUrl(
  ticket: string,
  question: string,
  systemPrompt?: string,
): string {
  const search = new URLSearchParams({ ticket, question });
  if (systemPrompt?.trim()) search.set('systemPrompt', systemPrompt.trim());
  return `/api/v1/chat/stream?${search.toString()}`;
}
