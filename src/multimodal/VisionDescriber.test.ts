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
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.model).toBe('qwen-vl-max');
    const imagePart = body.messages[0]?.content.find(
      (part) => part.type === 'image_url',
    );
    expect(imagePart).toMatchObject({
      image_url: { url: expect.stringContaining('data:image/png;base64,') },
    });
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
