import type { ReActTraceRecord } from '../types/admin-and-console.js';

export type RedactionCategory = 'phone' | 'email' | 'idCard' | 'secret';

export interface RedactionOptions {
  phone?: boolean;
  email?: boolean;
  idCard?: boolean;
  secret?: boolean;
}

const ALL_ENABLED: Required<RedactionOptions> = {
  phone: true,
  email: true,
  idCard: true,
  secret: true,
};

function maskMiddle(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

const ID_CARD = /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
const PHONE = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const PREFIXED_TOKEN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const KEY_VALUE =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\s*[=:]\s*["']?)([^\s"'&,;，。]{6,})/gi;
const URL_QUERY =
  /([?&](?:access_token|refresh_token|api_key|token|secret|password)=)([^&\s]{6,})/gi;

/** 按类别脱敏文本；默认四类全开，用于日志与 ReAct 轨迹落库前处理 */
export function redactText(
  text: string,
  options: RedactionOptions = {},
): string {
  if (!text) return text;
  const enabled = { ...ALL_ENABLED, ...options };
  let output = text;
  if (enabled.idCard) {
    output = output.replace(ID_CARD, (match) => maskMiddle(match));
  }
  if (enabled.phone) {
    output = output.replace(PHONE, (_match, head: string, tail: string) => {
      return `${head}****${tail}`;
    });
  }
  if (enabled.email) {
    output = output.replace(
      EMAIL,
      (_match, first: string, domain: string) => `${first}***${domain}`,
    );
  }
  if (enabled.secret) {
    output = output
      .replace(BEARER, 'Bearer ****')
      .replace(PREFIXED_TOKEN, (match) => maskMiddle(match))
      .replace(GITHUB_TOKEN, (match) => maskMiddle(match))
      .replace(SLACK_TOKEN, (match) => maskMiddle(match))
      .replace(AWS_KEY, (match) => maskMiddle(match))
      .replace(
        KEY_VALUE,
        (_match, prefix: string, value: string) =>
          `${prefix}${value.length <= 8 ? '****' : maskMiddle(value)}`,
      )
      .replace(
        URL_QUERY,
        (_match, prefix: string, value: string) =>
          `${prefix}${value.length <= 8 ? '****' : maskMiddle(value)}`,
      );
  }
  return output;
}

/** 递归脱敏对象中的字符串，其他类型保持不变 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (value instanceof Date || value instanceof Error) return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = redactDeep(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** 轨迹落库前脱敏问题、推理、回答与工具入参/输出 */
export function redactTraceRecord(record: ReActTraceRecord): ReActTraceRecord {
  return {
    ...record,
    question: redactText(record.question),
    reasoning: redactText(record.reasoning),
    answer: redactText(record.answer),
    steps: record.steps.map((step) => ({
      ...step,
      ...(step.content !== undefined
        ? { content: redactText(step.content) }
        : {}),
      ...(step.output !== undefined
        ? { output: redactText(step.output) }
        : {}),
      ...(step.arguments
        ? {
            arguments: redactDeep(step.arguments) as Record<string, unknown>,
          }
        : {}),
    })),
  };
}
