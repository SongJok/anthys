import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { maskSecret } from '../../config/DynamicConfigCenter.js';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import type {
  AdminAuditLog,
  GroupDirectory,
  LlmSandboxTestResult,
  McpServerStatusView,
  ReActTraceStore,
} from '../../types/admin-and-console.js';
import type { DynamicLoopPolicy } from '../../types/core.js';

export interface ConfigRouteDeps {
  configCenter: DynamicConfigCenter;
  traces: ReActTraceStore;
  groups: GroupDirectory;
  /** 当前已订阅旁听长连接的群；缺省时按“未订阅”展示 */
  listeningGroups?: () => Iterable<string>;
  mcpStatus?: () => McpServerStatusView[];
  /** Web 控制台在线调试人设：返回真实模型回答 */
  llmTester?: (input: {
    question: string;
    systemPrompt?: string;
  }) => Promise<LlmSandboxTestResult>;
  /** 钉钉连通性检查与测试卡片发送 */
  dingtalkTester?: {
    streamStatus(): { connected: boolean; detail?: string };
    sendTestCard(staffId?: string): Promise<{ ok: boolean; error?: string }>;
  };
  now?: () => number;
}

function startOfDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: '请求体必须是合法 JSON' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HTTPException(400, { message: '请求体必须是 JSON 对象' });
  }
  return body as Record<string, unknown>;
}

export function readString(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new HTTPException(400, { message: `缺少字段 ${key}` });
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HTTPException(400, { message: `字段 ${key} 必须是字符串` });
  }
  return value;
}

export function readBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new HTTPException(400, { message: `字段 ${key} 必须是布尔值` });
  }
  return value;
}

export function readNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HTTPException(400, { message: `字段 ${key} 必须是数字` });
  }
  return parsed;
}

export function readStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HTTPException(400, { message: `字段 ${key} 必须是字符串数组` });
  }
  return value as string[];
}

function readObject(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPException(400, { message: `字段 ${key} 必须是对象` });
  }
  return value as Record<string, unknown>;
}

/** 管理后台 Web 改动同样落审计，保证 ChatOps 与 Web 双通道可追溯 */
export async function recordWebAudit(
  center: DynamicConfigCenter,
  actorStaffId: string,
  actionType: AdminAuditLog['actionType'],
  beforeSnapshot: Record<string, unknown>,
  afterSnapshot: Record<string, unknown>,
): Promise<void> {
  try {
    await center.recordAudit({
      adminStaffId: actorStaffId,
      adminNick: actorStaffId,
      actionType,
      beforeSnapshot,
      afterSnapshot,
    });
  } catch {
    // 审计落库失败不能阻断已生效的热更新
  }
}

export function webActor(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const id = c.req.header('x-admin-staff-id')?.trim();
  return id && id.length > 0 ? id : 'web-console';
}

/** 表单回传掩码时视为保持原值，避免把掩码写成真实密钥 */
function isSecretMask(input: string | undefined, current: string): boolean {
  return input !== undefined && input.trim() === maskSecret(current);
}

/** 管理后台配置路由：钉钉、LLM/人设、群策略、审计大盘与 ReAct 轨迹 */
export function createConfigRoutes(deps: ConfigRouteDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const actor = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('x-admin-staff-id');

  app.get('/config/dingtalk', (c) =>
    c.json({
      ok: true,
      config: deps.configCenter.getSystemConfig().dingtalk,
      stream: deps.dingtalkTester?.streamStatus() ?? null,
    }),
  );

  app.put('/config/dingtalk', async (c) => {
    const body = await readJsonBody(c);
    const before = deps.configCenter.getSystemConfig().dingtalk;
    const clientSecret = readString(body, 'clientSecret');
    const currentSecret = deps.configCenter.getDingTalkConfig().clientSecret;
    await deps.configCenter.updateDingTalk(
      {
        ...(readString(body, 'clientId') !== undefined
          ? { clientId: readString(body, 'clientId')! }
          : {}),
        ...(clientSecret !== undefined &&
        !isSecretMask(clientSecret, currentSecret)
          ? { clientSecret }
          : {}),
        ...(readString(body, 'robotCode') !== undefined
          ? { robotCode: readString(body, 'robotCode')! }
          : {}),
        ...(readString(body, 'aiCardTemplateId') !== undefined
          ? { aiCardTemplateId: readString(body, 'aiCardTemplateId')! }
          : {}),
        ...(readStringArray(body, 'adminStaffIds') !== undefined
          ? { adminStaffIds: readStringArray(body, 'adminStaffIds')! }
          : {}),
        ...(readBoolean(body, 'dwsCliEnabled') !== undefined
          ? { dwsCliEnabled: readBoolean(body, 'dwsCliEnabled')! }
          : {}),
      },
      actor(c),
    );
    const after = deps.configCenter.getSystemConfig().dingtalk;
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_DINGTALK',
      { ...before },
      { ...after },
    );
    return c.json({
      ok: true,
      config: after,
      stream: deps.dingtalkTester?.streamStatus() ?? null,
    });
  });

  app.post('/config/dingtalk/test-card', async (c) => {
    if (!deps.dingtalkTester) {
      throw new HTTPException(501, { message: '未配置钉钉测试卡片发送能力' });
    }
    const body = await readJsonBody(c).catch(() => ({}));
    const result = await deps.dingtalkTester.sendTestCard(
      (body as Record<string, unknown>).staffId as string | undefined,
    );
    return c.json({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  });

  app.get('/config/llm', (c) => {
    const system = deps.configCenter.getSystemConfig();
    return c.json({
      ok: true,
      llm: system.llm,
      loopPolicy: system.loopPolicy,
      persona: system.llm.persona,
    });
  });

  app.put('/config/llm', async (c) => {
    const body = await readJsonBody(c);
    const before = deps.configCenter.getSystemConfig().llm;
    const persona = readObject(body, 'persona');
    const loop = readObject(body, 'loop');
    const provider = readString(body, 'provider');
    const apiKey = readString(body, 'apiKey');
    const currentApiKey = deps.configCenter.getLLMConfig().apiKey;
    if (
      provider !== undefined &&
      provider !== 'openai-compatible' &&
      provider !== 'anthropic'
    ) {
      throw new HTTPException(400, {
        message: 'provider 必须是 openai-compatible 或 anthropic',
      });
    }
    await deps.configCenter.updateLLM(
      {
        ...(provider ? { provider: provider as 'openai-compatible' } : {}),
        ...(readString(body, 'baseUrl') !== undefined
          ? { baseUrl: readString(body, 'baseUrl')! }
          : {}),
        ...(readString(body, 'model') !== undefined
          ? { model: readString(body, 'model')! }
          : {}),
        ...(apiKey !== undefined && !isSecretMask(apiKey, currentApiKey)
          ? { apiKey }
          : {}),
        ...(readNumber(body, 'temperature') !== undefined
          ? { temperature: readNumber(body, 'temperature')! }
          : {}),
        ...(readBoolean(body, 'enableNativeReasoning') !== undefined
          ? {
              enableNativeReasoning: readBoolean(
                body,
                'enableNativeReasoning',
              )!,
            }
          : {}),
        ...(persona
          ? {
              persona: {
                ...(readString(persona, 'name') !== undefined
                  ? { name: readString(persona, 'name')! }
                  : {}),
                ...(readString(persona, 'rolePrompt') !== undefined
                  ? { rolePrompt: readString(persona, 'rolePrompt')! }
                  : {}),
                ...(readString(persona, 'speakingStyle') !== undefined
                  ? { speakingStyle: readString(persona, 'speakingStyle')! }
                  : {}),
              },
            }
          : {}),
      },
      actor(c),
    );

    if (loop) {
      await deps.configCenter.updateLoopPolicy(
        {
          ...(readNumber(loop, 'maxWallTimeMs') !== undefined
            ? { maxWallTimeMs: readNumber(loop, 'maxWallTimeMs')! }
            : {}),
          ...(readNumber(loop, 'maxTotalTokens') !== undefined
            ? { maxTotalTokens: readNumber(loop, 'maxTotalTokens')! }
            : {}),
          ...(readNumber(loop, 'maxConsecutiveSameTool') !== undefined
            ? {
                maxConsecutiveSameTool: readNumber(
                  loop,
                  'maxConsecutiveSameTool',
                )!,
              }
            : {}),
          ...(readBoolean(loop, 'convergenceCheck') !== undefined
            ? { convergenceCheck: readBoolean(loop, 'convergenceCheck')! }
            : {}),
        } satisfies Partial<DynamicLoopPolicy>,
        actor(c),
      );
    }

    const system = deps.configCenter.getSystemConfig();
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_LLM',
      before as unknown as Record<string, unknown>,
      system.llm as unknown as Record<string, unknown>,
    );
    return c.json({
      ok: true,
      hotReloaded: true,
      llm: system.llm,
      loopPolicy: system.loopPolicy,
    });
  });

  app.post('/config/llm/test', async (c) => {
    if (!deps.llmTester) {
      throw new HTTPException(501, { message: '未配置沙盒对话测试能力' });
    }
    const body = await readJsonBody(c);
    const question = readString(body, 'question', { required: true })!;
    const systemPrompt = readString(body, 'systemPrompt');
    const result = await deps.llmTester({
      question,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    return c.json({ ok: true, result });
  });

  app.get('/groups', async (c) => {
    const [list, policies] = await Promise.all([
      deps.groups.listGroups(),
      deps.configCenter.listGroupPolicies(),
    ]);
    const policyMap = new Map(
      policies.map((policy) => [policy.conversationId, policy]),
    );
    const defaults = deps.configCenter.getSystemConfig().defaultBystanderPolicy;
    const listening = new Set(deps.listeningGroups?.() ?? []);
    return c.json({
      ok: true,
      defaults,
      groups: list.map((group) => ({
        ...group,
        // 只有真正订阅了长连接的群才会收到非 @ 消息；
        // 全局默认只决定判定阈值，不代表该群在监听
        listening: listening.has(group.conversationId),
        policyOverridden: policyMap.has(group.conversationId),
        policy: policyMap.get(group.conversationId) ?? {
          conversationId: group.conversationId,
          ...defaults,
        },
      })),
    });
  });

  app.get('/groups/:conversationId/policy', async (c) => {
    const conversationId = c.req.param('conversationId');
    return c.json({
      ok: true,
      policy: await deps.configCenter.getGroupPolicy(conversationId),
    });
  });

  app.put('/groups/:conversationId/policy', async (c) => {
    const conversationId = c.req.param('conversationId');
    const body = await readJsonBody(c);
    const before = await deps.configCenter.getGroupPolicy(conversationId);
    const policy = await deps.configCenter.updateGroupPolicy(
      conversationId,
      {
        ...(readBoolean(body, 'bystanderEnabled') !== undefined
          ? { bystanderEnabled: readBoolean(body, 'bystanderEnabled')! }
          : {}),
        ...(readBoolean(body, 'proactiveReplyEnabled') !== undefined
          ? {
              proactiveReplyEnabled: readBoolean(
                body,
                'proactiveReplyEnabled',
              )!,
            }
          : {}),
        ...(readNumber(body, 'cooldownSeconds') !== undefined
          ? { cooldownSeconds: readNumber(body, 'cooldownSeconds')! }
          : {}),
        ...(readNumber(body, 'slidingWindowSize') !== undefined
          ? { slidingWindowSize: readNumber(body, 'slidingWindowSize')! }
          : {}),
        ...(readNumber(body, 'confidenceThreshold') !== undefined
          ? { confidenceThreshold: readNumber(body, 'confidenceThreshold')! }
          : {}),
        ...(readStringArray(body, 'triggerTopics') !== undefined
          ? { triggerTopics: readStringArray(body, 'triggerTopics')! }
          : {}),
      },
      actor(c),
    );
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'UPDATE_GROUP_POLICY',
      before ? { ...before } : {},
      { ...policy },
    );
    return c.json({ ok: true, policy });
  });

  app.post('/groups/emergency-mute', async (c) => {
    const body = await readJsonBody(c).catch(() => ({} as Record<string, unknown>));
    const conversationId = readString(body, 'conversationId');
    const muted = await deps.configCenter.emergencyMute(
      conversationId,
      actor(c),
    );
    await recordWebAudit(
      deps.configCenter,
      webActor(c),
      'EMERGENCY_MUTE',
      { defaultMuted: conversationId === undefined },
      { conversationId: conversationId ?? null, muted },
    );
    return c.json({ ok: true, muted, defaultMuted: conversationId === undefined });
  });

  app.get('/traces', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(c.req.query('pageSize') ?? 20) || 20),
    );
    const conversationId = c.req.query('conversationId');
    const sinceMsRaw = c.req.query('sinceMs');
    const sinceMs = sinceMsRaw ? Number(sinceMsRaw) : undefined;
    const result = await deps.traces.query({
      page,
      pageSize,
      ...(conversationId ? { conversationId } : {}),
      ...(sinceMs !== undefined && Number.isFinite(sinceMs) ? { sinceMs } : {}),
    });
    return c.json({ ok: true, ...result });
  });

  app.get('/audit-logs', async (c) => {
    const limit = Math.min(
      200,
      Math.max(1, Number(c.req.query('limit') ?? 50) || 50),
    );
    return c.json({
      ok: true,
      logs: await deps.configCenter.listAuditLogs(limit),
    });
  });

  app.get('/dashboard', async (c) => {
    const nowMs = now();
    const [today, groups, auditLogs] = await Promise.all([
      deps.traces.dailyStats(startOfDay(nowMs), startOfDay(nowMs) + 86_400_000),
      deps.groups.listGroups(),
      deps.configCenter.listAuditLogs(10),
    ]);
    return c.json({
      ok: true,
      system: deps.configCenter.getSystemConfig(),
      mcpServers: deps.mcpStatus?.() ?? [],
      stream: deps.dingtalkTester?.streamStatus() ?? null,
      today,
      groups,
      auditLogs,
    });
  });

  return app;
}
