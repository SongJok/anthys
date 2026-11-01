import type {
  WorkerAction,
  WorkerFinding,
  WorkerOutput,
  WorkerRunStatus,
} from '../types/workers.js';

const MAX_SUMMARY_CHARS = 4_000;
const MAX_ITEM_CHARS = 600;
const MAX_ITEMS = 20;

export const WORKER_OUTPUT_CONTRACT = [
  '最终只输出一个 JSON 对象，不要输出 JSON 之外的文字、Markdown 代码围栏或额外解释：',
  '{"status":"completed|partial|blocked","summary":"给用户看的结论（不超过 800 字）","findings":[{"claim":"已核实的事实","source":"来源链接或位置"}],"actions":[{"action":"已执行或建议的操作","result":"执行结果或待确认原因"}],"sources":["关键链接"],"openQuestions":["仍需确认的问题"]}',
  'status 含义：completed=已完成；partial=部分完成；blocked=需要用户确认或被权限阻塞。',
  '没有内容的数组必须输出 []，不要省略字段。',
].join('\n');

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clip(text: string, limit = MAX_ITEM_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toFinding(value: unknown): WorkerFinding | null {
  const text = asText(value);
  if (text) return { claim: clip(text) };
  const record = toRecord(value);
  if (!record) return null;
  const claim = asText(
    record.claim ?? record.finding ?? record.text ?? record.statement,
  );
  if (!claim) return null;
  const source = asText(
    record.source ?? record.url ?? record.evidence ?? record.location,
  );
  return {
    claim: clip(claim),
    ...(source ? { source: clip(source) } : {}),
  };
}

function toAction(value: unknown): WorkerAction | null {
  const text = asText(value);
  if (text) return { action: clip(text) };
  const record = toRecord(value);
  if (!record) return null;
  const action = asText(record.action ?? record.step ?? record.text);
  if (!action) return null;
  const result = asText(record.result ?? record.outcome ?? record.status);
  return {
    action: clip(action),
    ...(result ? { result: clip(result) } : {}),
  };
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const text = asText(entry);
    if (text) items.push(clip(text));
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function toStatus(value: unknown): WorkerRunStatus {
  return value === 'completed' || value === 'blocked' || value === 'partial'
    ? value
    : 'partial';
}

/**
 * 解析 Worker 的结构化回执。宽松提取首个 JSON 对象并归一化字段，
 * 解析失败返回 null，由调用方回退为原始回答，避免任务整体失败。
 */
export function parseWorkerOutput(text: string): WorkerOutput | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let root: Record<string, unknown> | null;
  try {
    root = toRecord(JSON.parse(json));
  } catch {
    return null;
  }
  if (!root) return null;

  const summary = asText(root.summary ?? root.answer ?? root.conclusion);
  if (!summary) return null;

  const findings = Array.isArray(root.findings)
    ? root.findings
        .map(toFinding)
        .filter((item): item is WorkerFinding => item !== null)
        .slice(0, MAX_ITEMS)
    : [];
  const actions = Array.isArray(root.actions)
    ? root.actions
        .map(toAction)
        .filter((item): item is WorkerAction => item !== null)
        .slice(0, MAX_ITEMS)
    : [];

  return {
    status: toStatus(root.status),
    summary: clip(summary, MAX_SUMMARY_CHARS),
    findings,
    actions,
    sources: toStringList(root.sources),
    openQuestions: toStringList(root.openQuestions ?? root.open_questions),
  };
}
