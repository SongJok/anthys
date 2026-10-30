/**
 * 阶段三：群聊旁听、非 @ 自主回复与三层记忆的公共契约。
 */

/** 1. 群聊旁听策略配置契约 */
export interface GroupBystanderPolicy {
  conversationId: string;
  bystanderEnabled: boolean;
  proactiveReplyEnabled: boolean;
  slidingWindowSize: number;
  cooldownSeconds: number;
  confidenceThreshold: number;
  triggerTopics: string[];
}

/** 2. 旁听意图评估输出契约 */
export interface BystanderEvaluationResult {
  action: 'SILENT' | 'PROACTIVE_REPLY';
  confidence: number;
  triggerReason: 'PROD_INCIDENT' | 'UNANSWERED_QUESTION' | 'FACT_CHECK' | 'NONE';
  extractedQuery: string;
  rationale: string;
}

export type BystanderDecision = BystanderEvaluationResult;
export type BystanderAction = BystanderEvaluationResult['action'];
export type BystanderTriggerReason =
  BystanderEvaluationResult['triggerReason'];

/** 3. 三层记忆组装快照契约 */
export interface AssembledMemoryContext {
  personaSystemPrompt: string;
  userSemanticProfile: string;
  groupRecentTranscript: string;
  episodicSummary: string;
  activeTurnMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** 旁听滚动窗口中的一条群消息 */
export interface TranscriptEntry {
  conversationId: string;
  messageId: string;
  senderStaffId: string;
  senderNick: string;
  text: string;
  isAtBot: boolean;
  /** epoch ms */
  timestamp: number;
}

/** 情景记忆：一段被压缩归档的历史对话 */
export interface EpisodicSummaryRecord {
  id: string;
  conversationId: string;
  summary: string;
  coveredMessageIds: string[];
  tokenCount: number;
  createdAt: number;
}

export type SemanticMemoryScope = 'global' | 'group' | 'user';
export type SemanticMemoryKind = 'terminology' | 'profile';

/** 语义记忆：企业黑话/项目代号映射或员工职责画像 */
export interface SemanticMemoryRecord {
  id: string;
  scope: SemanticMemoryScope;
  /** group 会话 ID、user staffId 或 'global' */
  subjectKey: string;
  kind: SemanticMemoryKind;
  content: string;
  keywords: string[];
  embedding: number[] | null;
  updatedAt: number;
}

export interface SemanticRecallQuery {
  query: string;
  scope?: SemanticMemoryScope;
  subjectKey?: string;
  limit?: number;
  /** 有值时按 pgvector 余弦距离排序 */
  embedding?: number[];
}

export interface SemanticRecallResult {
  profileLines: string[];
  glossaryLines: string[];
}

export const DEFAULT_SLIDING_WINDOW_SIZE = 20;
export const DEFAULT_COOLDOWN_SECONDS = 180;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.82;
export const DEFAULT_TRIGGER_TOPICS = [
  '线上故障',
  'SQL查询',
  '接口报错',
  '发布排期',
];

export function createDefaultBystanderPolicy(
  conversationId: string,
  overrides: Partial<
    Omit<GroupBystanderPolicy, 'conversationId'>
  > = {},
): GroupBystanderPolicy {
  return {
    conversationId,
    bystanderEnabled: true,
    proactiveReplyEnabled: true,
    slidingWindowSize: DEFAULT_SLIDING_WINDOW_SIZE,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    triggerTopics: [...DEFAULT_TRIGGER_TOPICS],
    ...overrides,
  };
}
