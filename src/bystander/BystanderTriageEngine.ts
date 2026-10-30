import { CooldownLimiter } from './CooldownLimiter.js';
import { GroupTranscriptBuffer } from './GroupTranscriptBuffer.js';
import type {
  BystanderEvaluationResult,
  GroupBystanderPolicy,
  TranscriptEntry,
} from '../types/bystander-and-memory.js';
import type { ChatMessage, ChatModel, InboundMessage } from '../types/core.js';

/** L2 判官看到的群聊上下文条数 */
const L2_WINDOW_SIZE = 15;
const DEFAULT_DEBOUNCE_MS = 8_000;
const DEFAULT_BUSY_WINDOW_SECONDS = 30;
const DEFAULT_BUSY_MESSAGE_LIMIT = 12;

const TRIVIAL_MESSAGES = new Set([
  '收到',
  '收到收到',
  '好的',
  '好',
  '好的好的',
  '嗯',
  '嗯嗯',
  '哦',
  '在',
  '在吗',
  '1',
  '11',
  '111',
  'ok',
  'okay',
  '谢谢',
  '多谢',
  '辛苦',
  '辛苦了',
  '哈哈',
  '哈哈哈',
  '呵呵',
  '是的',
  '对',
  '可以',
  '行',
  '666',
  '牛',
]);

const INCIDENT_PATTERN =
  /(报错|异常|超时|失败|崩溃|崩了|宕机|挂了|告警|火警|error|exception|panic|traceback|stack\s*trace|timeout|oom|\b5\d{2}\b)/iu;
const TECHNICAL_PATTERN =
  /(接口|服务|日志|数据库|sql|缓存|网关|部署|发布|上线|配置|环境|代码|版本|监控|链路|qps|并发|队列|集群|容器|k8s|redis|mysql|mq|回滚|扩容|限流|熔断|线程|内存|磁盘|cpu)/iu;
const QUESTION_PATTERN =
  /([?？]|怎么|为什么|为啥|如何|是不是|有没有|谁(在|能|来|看)|帮忙|求助|请问|能否|可以帮|看一下|查一下)/u;
const FACT_PATTERN =
  /((数据|报表|金额|统计|对账|数字|指标).*(不对|不一致|对不上|偏差|少了|多了|异常))|((不对|不一致|对不上|偏差|少了|多了).*(数据|报表|金额|统计|对账|数字|指标))/u;

export interface BystanderClassifierInput {
  conversationId: string;
  current: TranscriptEntry;
  /** 最近 15 条旁听消息（含当前消息） */
  window: TranscriptEntry[];
  policy: GroupBystanderPolicy;
}

export interface BystanderClassifier {
  classify(input: BystanderClassifierInput): Promise<BystanderEvaluationResult>;
}

export interface BystanderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface BystanderTriageEngineOptions {
  buffer: GroupTranscriptBuffer;
  cooldown?: CooldownLimiter;
  classifier?: BystanderClassifier;
  /** 防抢答等待窗口，默认 8000ms */
  debounceMs?: number;
  /** 可注入的等待函数，便于测试与自定义调度 */
  sleep?: (ms: number) => Promise<void>;
  busyWindowSeconds?: number;
  busyMessageLimit?: number;
  now?: () => number;
  logger?: BystanderLogger;
}

function trimText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isTrivial(text: string): boolean {
  const normalized = text
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
  if (!normalized) return true;
  if (/^[\p{Extended_Pictographic}]+$/u.test(normalized)) return true;
  return TRIVIAL_MESSAGES.has(normalized);
}

function matchesTopic(text: string, topics: string[]): string | null {
  const normalized = text.toLowerCase();
  for (const topic of topics) {
    const value = topic.trim();
    if (!value) continue;
    if (normalized.includes(value.toLowerCase())) return value;
  }
  return null;
}

function looksActionable(
  text: string,
  contextText: string,
  policy: GroupBystanderPolicy,
): boolean {
  const combined = `${text}\n${contextText}`;
  if (matchesTopic(combined, policy.triggerTopics)) return true;
  if (INCIDENT_PATTERN.test(combined)) return true;
  if (TECHNICAL_PATTERN.test(combined)) return true;
  return false;
}

function buildExtractedQuery(
  text: string,
  window: TranscriptEntry[],
  reason: BystanderEvaluationResult['triggerReason'],
): string {
  const contextLines = window
    .filter(
      (entry) =>
        entry.text !== text &&
        (reason === 'PROD_INCIDENT'
          ? INCIDENT_PATTERN.test(entry.text)
          : TECHNICAL_PATTERN.test(entry.text) ||
            INCIDENT_PATTERN.test(entry.text)),
    )
    .slice(-2)
    .map((entry) => `${entry.senderNick}: ${trimText(entry.text)}`);

  const parts = [trimText(text)];
  if (contextLines.length > 0) {
    parts.push(`群聊上下文：${contextLines.join(' / ')}`);
  }
  return parts.join('\n').slice(0, 800);
}

/**
 * 启发式判官：无模型调用，作为默认 L2 与 LLM 判官失败时的低延迟基线。
 */
export class HeuristicBystanderClassifier implements BystanderClassifier {
  public async classify(
    input: BystanderClassifierInput,
  ): Promise<BystanderEvaluationResult> {
    const text = input.current.text;
    const recent = input.window
      .filter((entry) => entry.messageId !== input.current.messageId)
      .slice(-5);
    const contextText = recent
      .map((entry) => `${entry.senderNick}: ${entry.text}`)
      .join('\n');
    const topic = matchesTopic(`${text}\n${contextText}`, input.policy.triggerTopics);

    if (INCIDENT_PATTERN.test(text)) {
      return {
        action: 'PROACTIVE_REPLY',
        confidence: 0.93,
        triggerReason: 'PROD_INCIDENT',
        extractedQuery: buildExtractedQuery(text, input.window, 'PROD_INCIDENT'),
        rationale: 'heuristic: 当前消息命中线上故障/报错特征',
      };
    }

    if (INCIDENT_PATTERN.test(contextText) && QUESTION_PATTERN.test(text)) {
      return {
        action: 'PROACTIVE_REPLY',
        confidence: 0.87,
        triggerReason: 'PROD_INCIDENT',
        extractedQuery: buildExtractedQuery(text, input.window, 'PROD_INCIDENT'),
        rationale: 'heuristic: 追问发生在近期故障讨论上下文中',
      };
    }

    if (FACT_PATTERN.test(text)) {
      return {
        action: 'PROACTIVE_REPLY',
        confidence: 0.85,
        triggerReason: 'FACT_CHECK',
        extractedQuery: buildExtractedQuery(text, input.window, 'FACT_CHECK'),
        rationale: 'heuristic: 发现数据/指标口径不一致信号',
      };
    }

    if (
      QUESTION_PATTERN.test(text) &&
      (TECHNICAL_PATTERN.test(`${text}\n${contextText}`) || topic !== null)
    ) {
      return {
        action: 'PROACTIVE_REPLY',
        confidence: topic !== null ? 0.88 : 0.86,
        triggerReason: 'UNANSWERED_QUESTION',
        extractedQuery: buildExtractedQuery(
          text,
          input.window,
          'UNANSWERED_QUESTION',
        ),
        rationale: `heuristic: 群内技术求助${topic ? `（命中主题「${topic}」）` : ''}`,
      };
    }

    return {
      action: 'SILENT',
      confidence: 0.1,
      triggerReason: 'NONE',
      extractedQuery: '',
      rationale: 'heuristic: 无明确故障、求助或事实核查信号',
    };
  }
}

const LLM_SYSTEM_PROMPT = [
  '你是企业钉钉群里的旁听意图判官，只输出 JSON，不要输出解释或 Markdown。',
  '判断最新一条群消息是否值得机器人主动插话。仅以下情况返回 PROACTIVE_REPLY：',
  '1) PROD_INCIDENT：高优先级线上告警、报错堆栈、接口 5xx、服务不可用；',
  '2) UNANSWERED_QUESTION：悬而未决的技术/业务求助，且群内尚无人给出有效回应；',
  '3) FACT_CHECK：明显的数据口径偏差、指标对不上。',
  '闲聊、表情、确认短语、已经有人回答的问题、与工作无关的话题必须 SILENT。',
  '输出字段：action(SILENT|PROACTIVE_REPLY), confidence(0~1),',
  'triggerReason(PROD_INCIDENT|UNANSWERED_QUESTION|FACT_CHECK|NONE),',
  'extractedQuery(交给查证引擎的核心问题), rationale(内部审计依据)。',
].join('\n');

function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('classifier returned no JSON object');
  }
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('classifier JSON must be an object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * L2 小模型判官：复用同一 ChatModel 的 JSON 分类模式，低温度、无工具、无思维链。
 */
export class LlmBystanderClassifier implements BystanderClassifier {
  constructor(
    private readonly options: {
      model: ChatModel;
      temperature?: number;
      logger?: BystanderLogger;
      now?: () => number;
    },
  ) {}

  public async classify(
    input: BystanderClassifierInput,
  ): Promise<BystanderEvaluationResult> {
    const transcript = input.window
      .map(
        (entry, index) =>
          `${index + 1}. [${entry.senderNick}] ${trimText(entry.text)}`,
      )
      .join('\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: LLM_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `重点关注主题：${input.policy.triggerTopics.join('、') || '无'}`,
          '最近群聊：',
          transcript,
          '最新消息（待判定）：',
          `[${input.current.senderNick}] ${trimText(input.current.text)}`,
        ].join('\n'),
      },
    ];

    let content = '';
    for await (const chunk of this.options.model.streamChat({
      messages,
      tools: [],
      toolChoice: 'none',
      temperature: this.options.temperature ?? 0,
      enableNativeReasoning: false,
    })) {
      content += chunk.contentDelta ?? '';
    }

    const parsed = extractJsonObject(content);
    const action =
      parsed.action === 'PROACTIVE_REPLY' ? 'PROACTIVE_REPLY' : 'SILENT';
    const rawConfidence = Number(parsed.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0;
    const reasonCandidates = [
      'PROD_INCIDENT',
      'UNANSWERED_QUESTION',
      'FACT_CHECK',
      'NONE',
    ] as const;
    const triggerReason =
      reasonCandidates.find((item) => item === parsed.triggerReason) ?? 'NONE';
    const extractedQuery =
      typeof parsed.extractedQuery === 'string' && parsed.extractedQuery.trim()
        ? parsed.extractedQuery.trim()
        : trimText(input.current.text);
    const rationale =
      typeof parsed.rationale === 'string' && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : 'llm: 未提供依据';

    return { action, confidence, triggerReason, extractedQuery, rationale };
  }
}

/**
 * 三级旁听漏斗：
 * L1 规则与冷却（零 Token）→ 防抢答等待 → L2 语义判定 → 置信度门禁 → L3 由 Harness 唤醒 ReAct。
 * 非 @ 消息只有通过全部关卡才会返回 PROACTIVE_REPLY。
 */
export class BystanderTriageEngine {
  private readonly buffer: GroupTranscriptBuffer;
  private readonly cooldown: CooldownLimiter;
  private readonly classifier: BystanderClassifier;
  private readonly debounceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly busyWindowSeconds: number;
  private readonly busyMessageLimit: number;
  private readonly now: () => number;
  private readonly logger?: BystanderLogger;

  constructor(options: BystanderTriageEngineOptions) {
    this.buffer = options.buffer;
    this.now = options.now ?? Date.now;
    this.cooldown = options.cooldown ?? new CooldownLimiter({ now: this.now });
    this.classifier =
      options.classifier ?? new HeuristicBystanderClassifier();
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.busyWindowSeconds = Math.max(
      1,
      options.busyWindowSeconds ?? DEFAULT_BUSY_WINDOW_SECONDS,
    );
    this.busyMessageLimit = Math.max(
      1,
      options.busyMessageLimit ?? DEFAULT_BUSY_MESSAGE_LIMIT,
    );
    this.logger = options.logger;
  }

  public async evaluate(
    message: InboundMessage,
    policy: GroupBystanderPolicy,
  ): Promise<BystanderEvaluationResult> {
    const silent = (rationale: string): BystanderEvaluationResult => ({
      action: 'SILENT',
      confidence: 0,
      triggerReason: 'NONE',
      extractedQuery: '',
      rationale,
    });

    if (message.conversationType !== '2' || message.isAtBot) {
      return silent('L1: 仅评估群聊非 @ 消息');
    }

    const current: TranscriptEntry = {
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderStaffId: message.senderStaffId,
      senderNick: message.senderNick,
      text: message.text,
      isAtBot: message.isAtBot,
      timestamp: message.timestamp,
    };
    this.buffer.configure(message.conversationId, policy.slidingWindowSize);
    this.buffer.append(current);

    if (!policy.bystanderEnabled) {
      return silent('L1: 该群未开启旁听');
    }
    if (!policy.proactiveReplyEnabled) {
      return silent('L1: 该群未开启非 @ 自主回复');
    }
    if (isTrivial(message.text)) {
      return silent('L1: 表情/确认短语，无需打扰');
    }

    const now = this.now();
    const busySince = now - this.busyWindowSeconds * 1000;
    const recentCount = this.buffer
      .entriesSince(message.conversationId, busySince)
      .length;
    if (recentCount >= this.busyMessageLimit) {
      return silent(`L1: 群内近 ${this.busyWindowSeconds}s 过于活跃，暂不插话`);
    }

    if (this.cooldown.isCoolingDown(message.conversationId, policy.cooldownSeconds)) {
      const remaining = this.cooldown.remainingSeconds(
        message.conversationId,
        policy.cooldownSeconds,
      );
      return silent(`L1: 主动回复冷却中，剩余 ${remaining}s`);
    }

    const contextText = this.buffer
      .recent(message.conversationId, 6)
      .filter((entry) => entry.messageId !== message.messageId)
      .map((entry) => `${entry.senderNick}: ${entry.text}`)
      .join('\n');
    if (!looksActionable(message.text, contextText, policy)) {
      return silent('L1: 未命中技术信号或关注主题');
    }

    this.logger?.info(
      {
        conversationId: message.conversationId,
        messageId: message.messageId,
        debounceMs: this.debounceMs,
      },
      'bystander candidate waiting for debounce window',
    );
    await this.sleep(this.debounceMs);

    const memberReplies = this.buffer
      .entriesSince(message.conversationId, message.timestamp, message.messageId)
      .filter((entry) => entry.senderStaffId !== message.senderStaffId);
    if (memberReplies.length > 0) {
      return silent(
        `debounce: 防抢答窗口内已有 ${memberReplies.length} 条同事回复，取消主动插话`,
      );
    }

    if (this.cooldown.isCoolingDown(message.conversationId, policy.cooldownSeconds)) {
      const remaining = this.cooldown.remainingSeconds(
        message.conversationId,
        policy.cooldownSeconds,
      );
      return silent(`L1: 等待期间进入主动回复冷却，剩余 ${remaining}s`);
    }

    const window = this.mergeWindow(
      this.buffer.recent(
        message.conversationId,
        Math.min(L2_WINDOW_SIZE, policy.slidingWindowSize),
      ),
      current,
    );

    let decision: BystanderEvaluationResult;
    try {
      decision = await this.classifier.classify({
        conversationId: message.conversationId,
        current,
        window,
        policy,
      });
    } catch (error) {
      this.logger?.warn(
        {
          conversationId: message.conversationId,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'bystander classifier failed, staying silent',
      );
      return silent('L2: 判官异常，保守静默');
    }

    const accepted =
      decision.action === 'PROACTIVE_REPLY' &&
      decision.triggerReason !== 'NONE' &&
      decision.confidence >= policy.confidenceThreshold;

    this.logger?.info(
      {
        conversationId: message.conversationId,
        messageId: message.messageId,
        action: decision.action,
        triggerReason: decision.triggerReason,
        confidence: decision.confidence,
        threshold: policy.confidenceThreshold,
        rationale: decision.rationale,
      },
      'bystander triage decision',
    );

    if (!accepted) {
      return {
        ...decision,
        action: 'SILENT',
        extractedQuery: '',
        rationale:
          decision.action === 'PROACTIVE_REPLY'
            ? `L2: 置信度 ${decision.confidence.toFixed(2)} 低于阈值 ${policy.confidenceThreshold.toFixed(2)}；${decision.rationale}`
            : `L2: ${decision.rationale}`,
      };
    }

    this.cooldown.markReplied(message.conversationId, now);
    return {
      ...decision,
      extractedQuery:
        decision.extractedQuery.trim() || trimText(message.text),
    };
  }

  public isCoolingDown(
    conversationId: string,
    policy: GroupBystanderPolicy,
  ): boolean {
    return this.cooldown.isCoolingDown(
      conversationId,
      policy.cooldownSeconds,
    );
  }

  private mergeWindow(
    entries: TranscriptEntry[],
    current: TranscriptEntry,
  ): TranscriptEntry[] {
    const merged = entries.some((entry) => entry.messageId === current.messageId)
      ? entries
      : [...entries, current];
    return merged.slice(-L2_WINDOW_SIZE);
  }
}
