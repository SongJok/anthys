/**
 * 群聊静默调查（P0-2）：对 SILENT 消息做只读查证，
 * 证据达标才浮出回复，否则静默丢弃并留审计。
 */
import type { RunUsage } from './core.js';

export type InvestigationStatus = 'surfaced' | 'discarded' | 'failed';

export interface SilentInvestigationConfig {
  enabled: boolean;
  /** 旁听判定置信度低于该值不启动调查 */
  minConfidence: number;
  /** 证据评分达到该值才允许浮出 */
  evidenceThreshold: number;
  /** 单次调查的 token 预算，超出即丢弃 */
  maxTokens: number;
  maxWallTimeMs: number;
  /** 同一群两次调查之间的最小间隔 */
  cooldownSeconds: number;
  minQueryChars: number;
  /** 进程内同时执行的调查数量上限 */
  maxConcurrency: number;
}

export interface InvestigationEvidence {
  /** 0-1 的确定性证据分，包含模型自评与结构化依据 */
  score: number;
  confidence: number;
  findings: string[];
  sources: string[];
  answer: string;
  format: 'json' | 'text';
}

export interface InvestigationRunResult {
  answer: string;
  usage: RunUsage;
  model?: string;
}

export interface InvestigationAuditRecord {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  senderStaffId: string;
  query: string;
  status: InvestigationStatus;
  confidence: number;
  evidenceScore: number;
  reason: string;
  answer: string;
  tokens: number;
  durationMs: number;
  createdAt: number;
}

export interface InvestigationAuditStore {
  append(record: InvestigationAuditRecord): Promise<void>;
}
