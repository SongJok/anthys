export interface TextFallbackLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** 钉钉 markdown 消息有长度上限，按段落切分并保留顺序 */
export function splitMarkdown(text: string, maxChars = 1_500): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of trimmed.split(/\n{2,}/u)) {
    if (paragraph.length > maxChars) {
      push();
      for (let start = 0; start < paragraph.length; start += maxChars) {
        const slice = paragraph.slice(start, start + maxChars);
        if (start + maxChars >= paragraph.length) {
          current = slice;
        } else {
          chunks.push(slice);
        }
      }
      continue;
    }
    if ((current ? `${current}\n\n` : '').length + paragraph.length > maxChars) {
      push();
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return chunks;
}

export interface TextFallbackInput {
  webhook: string;
  text: string;
  title?: string;
  fetchImpl?: typeof fetch;
  logger?: TextFallbackLogger;
  maxRetries?: number;
  retryDelayMs?: number;
  maxChars?: number;
  timeoutMs?: number;
}

export interface TextFallbackResult {
  ok: boolean;
  chunks: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 卡片不可用时的降级通道：分片发送 markdown，单片失败按指数退避重试，
 * 某片最终失败仍继续发送后续分片，保证用户至少拿到部分内容。
 */
export async function sendTextFallback(
  input: TextFallbackInput,
): Promise<TextFallbackResult> {
  const chunks = splitMarkdown(input.text, input.maxChars ?? 1_500);
  if (chunks.length === 0) return { ok: true, chunks: 0 };
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxRetries = Math.max(0, input.maxRetries ?? 2);
  const retryDelayMs = input.retryDelayMs ?? 300;
  const title = input.title ?? '智能助手';
  let failed = 0;

  for (const [index, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）\n` : '';
    let sent = false;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetchImpl(input.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title, text: `${prefix}${chunk}` },
          }),
          signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
        });
        if (response.ok) {
          sent = true;
          break;
        }
        input.logger?.warn(
          {
            status: response.status,
            chunk: index + 1,
            attempt: attempt + 1,
          },
          'text fallback chunk rejected',
        );
      } catch (error) {
        input.logger?.warn(
          {
            chunk: index + 1,
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
          },
          'text fallback chunk failed',
        );
      }
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }
    if (!sent) failed += 1;
  }

  return failed === 0
    ? { ok: true, chunks: chunks.length }
    : {
        ok: false,
        chunks: chunks.length,
        error: `${failed}/${chunks.length} 个分片发送失败`,
      };
}
