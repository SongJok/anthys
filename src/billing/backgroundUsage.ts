import type { ChatStreamChunk } from '../types/core.js';

/** 后台维护类 LLM 调用的归因标签（写入 usage_ledger.worker / job_kind） */
export type BackgroundWorker =
  | 'triage'
  | 'memory_compress'
  | 'memory_extract';

export interface BackgroundUsageRecord {
  worker: BackgroundWorker;
  model: string;
  conversationId: string;
  conversationType: '1' | '2';
  senderStaffId: string;
  senderNick: string;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  durationMs: number;
}

export type BackgroundUsageRecorder = (
  record: BackgroundUsageRecord,
) => void | Promise<void>;

export interface StreamContentResult {
  content: string;
  usage?: ChatStreamChunk['usage'];
  durationMs: number;
}

/** 消费只取正文的模型流（判官/摘要/抽取），累积 content 与供应商 usage（取最后一次上报） */
export async function collectContentStream(
  stream: AsyncIterable<ChatStreamChunk>,
  now: () => number = Date.now,
): Promise<StreamContentResult> {
  const startedAt = now();
  let content = '';
  let usage: ChatStreamChunk['usage'];
  for await (const chunk of stream) {
    content += chunk.contentDelta ?? '';
    if (chunk.usage) usage = chunk.usage;
  }
  return {
    content,
    ...(usage ? { usage } : {}),
    durationMs: Math.max(0, now() - startedAt),
  };
}

/** 记账失败绝不阻断后台维护链路：同步抛出与异步拒绝都吞掉 */
export async function reportBackgroundUsage(
  recorder: BackgroundUsageRecorder | undefined,
  record: BackgroundUsageRecord,
): Promise<void> {
  if (!recorder || record.totalTokens <= 0) return;
  try {
    await recorder(record);
  } catch {
    // 后台用量记账失败仅影响报表完整性，不应让判官/记忆维护失败
  }
}