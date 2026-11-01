import { randomUUID } from 'node:crypto';
import type {
  BystanderEvaluationResult,
  GroupBystanderPolicy,
} from '../types/bystander-and-memory.js';
import type { InboundMessage } from '../types/core.js';
import type {
  InvestigationAuditRecord,
  InvestigationAuditStore,
  InvestigationEvidence,
  InvestigationRunResult,
  InvestigationStatus,
  SilentInvestigationConfig,
} from '../types/investigation.js';
import type { CooldownLimiter } from './CooldownLimiter.js';

const URL_PATTERN = /https?:\/\/[^\s"'<>）)]+/gi;
const URL_TEST = /https?:\/\//i;
const EVIDENCE_MARKER_PATTERN =
  /(根据|依据|来源|数据显示|文档|日志|接口返回|查询结果|监控)/;
const HEDGE_PATTERN =
  /(无法(确认|核实|判断|给出)|不确定|没有(找到|查到|检索到)|证据不足)/;
const SURFACE_ANSWER_LIMIT = 1_200;

export interface SilentInvestigationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface InvestigationOutcome {
  status: InvestigationStatus;
  reason: string;
  evidenceScore: number;
  confidence: number;
  answer: string;
}

export interface SilentInvestigationInput {
  message: InboundMessage;
  decision: BystanderEvaluationResult;
  policy: GroupBystanderPolicy;
  signal?: AbortSignal;
}

export interface SilentInvestigationServiceOptions {
  config?: SilentInvestigationConfig;
  cooldown: Pick<CooldownLimiter, 'isCoolingDown' | 'markReplied'>;
  investigate(input: {
    message: InboundMessage;
    query: string;
    signal?: AbortSignal;
    maxWallTimeMs: number;
  }): Promise<InvestigationRunResult>;
  surface(message: InboundMessage, text: string): Promise<void>;
  auditStore?: InvestigationAuditStore;
  logger?: SilentInvestigationLogger;
  now?: () => number;
  newId?: () => string;
  /** 浮出成功后同步主旁听冷却，避免紧接着再主动回复一次 */
  onSurfaced?: (message: InboundMessage) => void;
}

function envEnabled(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveSilentInvestigationConfig(
  env: NodeJS.ProcessEnv,
): SilentInvestigationConfig {
  return {
    enabled: envEnabled(env.SILENT_INVESTIGATION_ENABLED, true),
    minConfidence: clamp01(
      envNumber(env.SILENT_INVESTIGATION_MIN_CONFIDENCE, 0.65),
    ),
    evidenceThreshold: clamp01(
      envNumber(env.SILENT_INVESTIGATION_EVIDENCE_THRESHOLD, 0.65),
    ),
    maxTokens: Math.max(
      500,
      Math.floor(envNumber(env.SILENT_INVESTIGATION_MAX_TOKENS, 8_000)),
    ),
    maxWallTimeMs:
      Math.max(
        5,
        envNumber(env.SILENT_INVESTIGATION_MAX_WALL_TIME_SECONDS, 45),
      ) * 1_000,
    cooldownSeconds: Math.max(
      0,
      envNumber(env.SILENT_INVESTIGATION_COOLDOWN_SECONDS, 600),
    ),
    minQueryChars: Math.max(
      1,
      Math.floor(envNumber(env.SILENT_INVESTIGATION_MIN_QUERY_CHARS, 10)),
    ),
    maxConcurrency: Math.max(
      1,
      Math.floor(envNumber(env.SILENT_INVESTIGATION_MAX_CONCURRENCY, 1)),
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = asRecord(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // 尝试下一个候选片段
    }
  }
  return null;
}

function pickStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text.length < 4 || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function extractUrls(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;，。；]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

/**
 * 确定性证据评分：模型自评占一部分，结构化 findings / sources 与
 * 可展示答案长度占其余部分，避免模型一句“我确定”就直接浮出。
 */
export function scoreInvestigationEvidence(text: string): InvestigationEvidence {
  const parsed = parseJsonObject(text);
  if (parsed) {
    const confidence = clamp01(
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0.5,
    );
    const findings = pickStringArray(parsed.findings, 5);
    const sources = pickStringArray(parsed.sources, 5);
    const answer =
      typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    const sourceWeight = sources.reduce(
      (sum, source) => sum + (URL_TEST.test(source) ? 0.1 : 0.05),
      0,
    );
    let score =
      0.35 * confidence +
      Math.min(findings.length, 3) * 0.12 +
      Math.min(sourceWeight, 0.2) +
      (answer.length >= 60 ? 0.09 : answer.length >= 20 ? 0.04 : -0.1);
    if (HEDGE_PATTERN.test(answer)) score -= 0.15;
    return {
      score: clamp01(Number(score.toFixed(4))),
      confidence,
      findings,
      sources,
      answer,
      format: 'json',
    };
  }

  const urls = extractUrls(text, 5);
  const answer = text.trim();
  let score =
    0.3 +
    (answer.length >= 120 ? 0.15 : answer.length >= 60 ? 0.08 : 0) +
    Math.min(urls.length, 2) * 0.15 +
    (EVIDENCE_MARKER_PATTERN.test(answer) ? 0.12 : 0);
  if (HEDGE_PATTERN.test(answer)) score -= 0.2;
  return {
    score: clamp01(Number(score.toFixed(4))),
    confidence: 0.5,
    findings: [],
    sources: urls,
    answer,
    format: 'text',
  };
}

function truncateAnswer(answer: string): string {
  return answer.length <= SURFACE_ANSWER_LIMIT
    ? answer
    : `${answer.slice(0, SURFACE_ANSWER_LIMIT)}…`;
}

/**
 * 群聊静默调查：SILENT 消息不直接回复，而是后台只读查证；
 * 证据达标且群允许主动回复时才浮出，否则静默丢弃并写审计。
 */
export class SilentInvestigationService {
  private readonly config: SilentInvestigationConfig;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly activeConversations = new Set<string>();

  constructor(private readonly options: SilentInvestigationServiceOptions) {
    this.config =
      options.config ?? resolveSilentInvestigationConfig(process.env);
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  public async consider(
    input: SilentInvestigationInput,
  ): Promise<InvestigationOutcome | null> {
    const { message, decision, policy } = input;
    const config = this.config;
    if (!config.enabled) return null;
    if (message.conversationType !== '2' || message.isAtBot) return null;
    if (decision.action !== 'SILENT') return null;
    if (decision.triggerReason === 'NONE') return null;
    if (!policy.bystanderEnabled || !policy.silentInvestigationEnabled) {
      return null;
    }
    // 主动回复关闭时调查结果无处浮出，直接省下预算
    if (!policy.proactiveReplyEnabled) return null;
    if (decision.confidence < config.minConfidence) return null;

    const query = (
      decision.extractedQuery.trim() || message.text.trim()
    ).trim();
    if (query.length < config.minQueryChars) return null;

    if (
      this.activeConversations.has(message.conversationId) ||
      this.activeConversations.size >= config.maxConcurrency
    ) {
      this.options.logger?.info(
        {
          conversationId: message.conversationId,
          messageId: message.messageId,
          active: this.activeConversations.size,
        },
        'silent investigation skipped: concurrency limit',
      );
      return null;
    }
    if (
      this.options.cooldown.isCoolingDown(
        message.conversationId,
        config.cooldownSeconds,
      )
    ) {
      this.options.logger?.info(
        { conversationId: message.conversationId },
        'silent investigation skipped: cooldown',
      );
      return null;
    }

    this.activeConversations.add(message.conversationId);
    try {
      return await this.runOnce(input, query);
    } finally {
      this.activeConversations.delete(message.conversationId);
      this.options.cooldown.markReplied(message.conversationId, this.now());
    }
  }

  private async runOnce(
    input: SilentInvestigationInput,
    query: string,
  ): Promise<InvestigationOutcome> {
    const { message, decision } = input;
    const startedAt = this.now();
    this.options.logger?.info(
      {
        conversationId: message.conversationId,
        messageId: message.messageId,
        triggerReason: decision.triggerReason,
        confidence: decision.confidence,
        queryChars: query.length,
      },
      'silent investigation started',
    );

    let result: InvestigationRunResult;
    try {
      result = await this.options.investigate({
        message,
        query,
        ...(input.signal ? { signal: input.signal } : {}),
        maxWallTimeMs: this.config.maxWallTimeMs,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const outcome: InvestigationOutcome = {
        status: 'failed',
        reason,
        evidenceScore: 0,
        confidence: 0,
        answer: '',
      };
      this.options.logger?.warn(
        {
          conversationId: message.conversationId,
          messageId: message.messageId,
          error: reason,
        },
        'silent investigation failed',
      );
      await this.writeAudit(input, outcome, {
        tokens: 0,
        durationMs: this.now() - startedAt,
      });
      return outcome;
    }

    const evidence = scoreInvestigationEvidence(result.answer);
    const durationMs = result.usage.durationMs || this.now() - startedAt;
    const tokens = result.usage.totalTokens;
    const answer = truncateAnswer(evidence.answer.trim());

    let outcome: InvestigationOutcome;
    if (tokens > this.config.maxTokens) {
      outcome = {
        status: 'discarded',
        reason: `超出调查预算（${tokens} > ${this.config.maxTokens} tokens）`,
        evidenceScore: evidence.score,
        confidence: evidence.confidence,
        answer,
      };
    } else if (answer.length < 20) {
      outcome = {
        status: 'discarded',
        reason: '模型未给出可展示的结论',
        evidenceScore: evidence.score,
        confidence: evidence.confidence,
        answer,
      };
    } else if (evidence.score < this.config.evidenceThreshold) {
      outcome = {
        status: 'discarded',
        reason: `证据分 ${evidence.score.toFixed(2)} 低于阈值 ${this.config.evidenceThreshold}`,
        evidenceScore: evidence.score,
        confidence: evidence.confidence,
        answer,
      };
    } else {
      try {
        await this.options.surface(message, answer);
        this.options.onSurfaced?.(message);
        outcome = {
          status: 'surfaced',
          reason: '证据达标，已浮出',
          evidenceScore: evidence.score,
          confidence: evidence.confidence,
          answer,
        };
      } catch (error) {
        outcome = {
          status: 'failed',
          reason: `结果发送失败：${
            error instanceof Error ? error.message : String(error)
          }`,
          evidenceScore: evidence.score,
          confidence: evidence.confidence,
          answer,
        };
      }
    }

    await this.writeAudit(input, outcome, { tokens, durationMs });
    this.options.logger?.info(
      {
        conversationId: message.conversationId,
        messageId: message.messageId,
        status: outcome.status,
        evidenceScore: evidence.score,
        confidence: evidence.confidence,
        tokens,
        durationMs,
        reason: outcome.reason,
      },
      'silent investigation finished',
    );
    return outcome;
  }

  private async writeAudit(
    input: SilentInvestigationInput,
    outcome: InvestigationOutcome,
    usage: { tokens: number; durationMs: number },
  ): Promise<void> {
    const store = this.options.auditStore;
    if (!store) return;
    const record: InvestigationAuditRecord = {
      id: this.newId(),
      conversationId: input.message.conversationId,
      triggerMessageId: input.message.messageId,
      senderStaffId: input.message.senderStaffId,
      query: (
        input.decision.extractedQuery.trim() || input.message.text.trim()
      ).trim(),
      status: outcome.status,
      confidence: outcome.confidence,
      evidenceScore: outcome.evidenceScore,
      reason: outcome.reason,
      answer: outcome.answer,
      tokens: usage.tokens,
      durationMs: usage.durationMs,
      createdAt: this.now(),
    };
    try {
      await store.append(record);
    } catch (error) {
      this.options.logger?.warn(
        {
          conversationId: input.message.conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to persist silent investigation audit',
      );
    }
  }
}
