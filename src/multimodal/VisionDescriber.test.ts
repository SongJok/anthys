import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAttachment } from './AttachmentStore.js';
import { OpenAiVisionDescriber } from './VisionDescriber.js';

describe('OpenAiVisionDescriber', () => {
  let dir: string;
  let imagePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vision-'));
    imagePath = join(dir, 'shot.png');
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function attachment(overrides: Partial<StoredAttachment> = {}): StoredAttachment {
    return {
      type: 'image',
      fileName: 'shot.png',
      localPath: imagePath,
      size: 4,
      mimeType: 'image/png',
      ...overrides,
    };
  }

  it('把本地图片编码为 data URL 并返回识别文本', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '  截图显示登录页报错 401  ' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const describer = new OpenAiVisionDescriber({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk-vision',
      model: 'qwen-vl-max',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(describer.describe(attachment())).resolves.toBe(
      '截图显示登录页报错 401',
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://vision.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer sk-vision',
    });
    const body = JSON.parse(String((init as RequestInit).body)) as {
      model: string;
      max_tokens: number;
      reasoning_effort?: string;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.model).toBe('qwen-vl-max');
    expect(body.max_tokens).toBe(4096);
    expect(body.reasoning_effort).toBeUndefined();
    const promptPart = body.messages[0]?.content.find(
      (part) => part.type === 'text',
    );
    expect(String(promptPart?.text)).toContain('逐字转录');
    const imagePart = body.messages[0]?.content.find(
      (part) => part.type === 'image_url',
    );
    expect(imagePart).toMatchObject({
      image_url: { url: expect.stringContaining('data:image/png;base64,') },
    });
  });

  it('支持自定义输出上限与推理档位', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '试卷文字' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const describer = new OpenAiVisionDescriber({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk',
      model: 'glm-5.3-flash',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxTokens: 6000,
      timeoutMs: 120_000,
      reasoningEffort: 'low',
    });

    await expect(describer.describe(attachment())).resolves.toBe('试卷文字');
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0]![1] as RequestInit).body),
    ) as { max_tokens: number; reasoning_effort?: string };
    expect(body.max_tokens).toBe(6000);
    expect(body.reasoning_effort).toBe('low');
  });

  it('输出被截断时自动扩容重试一次', async () => {
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '前半段' }, finish_reason: 'length' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '完整转录内容' }, finish_reason: 'stop' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const describer = new OpenAiVisionDescriber({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: {
        info: () => undefined,
        warn: (obj, msg) => warnings.push({ obj, msg }),
      },
    });

    await expect(describer.describe(attachment())).resolves.toBe('完整转录内容');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = JSON.parse(
      String((fetchImpl.mock.calls[0]![1] as RequestInit).body),
    ) as { max_tokens: number };
    const second = JSON.parse(
      String((fetchImpl.mock.calls[1]![1] as RequestInit).body),
    ) as { max_tokens: number };
    expect(first.max_tokens).toBe(4096);
    expect(second.max_tokens).toBe(8192);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain('truncated');
    expect(warnings[0]!.obj).toMatchObject({
      maxTokens: 4096,
      nextMaxTokens: 8192,
    });
  });

  it('扩容后仍截断时保留部分转录并提示不完整', async () => {
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const truncated = () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '部分内容' }, finish_reason: 'length' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(truncated())
      .mockResolvedValueOnce(truncated());
    const describer = new OpenAiVisionDescriber({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: {
        info: () => undefined,
        warn: (obj, msg) => warnings.push({ obj, msg }),
      },
    });

    const result = await describer.describe(attachment());
    expect(result).toContain('部分内容');
    expect(result).toContain('识别可能不完整');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      warnings.some((item) => item.msg.includes('still truncated')),
    ).toBe(true);
  });

  it('非图片附件直接返回 null', async () => {
    const fetchImpl = vi.fn();
    const describer = new OpenAiVisionDescriber({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      describer.describe(attachment({ type: 'file' })),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('接口失败时记录告警并降级为 null', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    const describer = new OpenAiVisionDescriber({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: (obj) => warnings.push(obj) },
    });

    await expect(describer.describe(attachment())).resolves.toBeNull();
    expect(warnings[0]?.error).toContain('500');
  });
});
