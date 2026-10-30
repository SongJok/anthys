import { describe, expect, it } from 'vitest';
import { OpenAIEmbeddingClient } from './EmbeddingClient.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAIEmbeddingClient', () => {
  it('按 index 还原顺序并请求 /embeddings', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new OpenAIEmbeddingClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      dimensions: 3,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          data: [
            { index: 1, embedding: [4, 5, 6] },
            { index: 0, embedding: [1, 2, 3] },
          ],
        });
      }) as typeof fetch,
    });

    const vectors = await client.embed(['第一段', '第二段']);
    expect(vectors).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/embeddings');
    expect(calls[0]?.body).toMatchObject({
      model: 'text-embedding-3-small',
      dimensions: 3,
      input: ['第一段', '第二段'],
    });
  });

  it('空输入不发请求', async () => {
    let called = false;
    const client = new OpenAIEmbeddingClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({ data: [] });
      }) as typeof fetch,
    });
    expect(await client.embed([' ', ''])).toEqual([]);
    expect(called).toBe(false);
  });

  it('维度不一致或请求失败时抛错', async () => {
    const dimensionMismatch = new OpenAIEmbeddingClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      dimensions: 3,
      fetchImpl: (async () =>
        jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] })) as typeof fetch,
    });
    await expect(dimensionMismatch.embed(['x'])).rejects.toThrow(
      'dimension mismatch',
    );

    const failed = new OpenAIEmbeddingClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      fetchImpl: (async () => jsonResponse({}, 500)) as typeof fetch,
    });
    await expect(failed.embed(['x'])).rejects.toThrow('500');
  });

  it('baseUrl 已指向 /embeddings 时不重复拼接', async () => {
    let url = '';
    const client = new OpenAIEmbeddingClient({
      baseUrl: 'https://api.example.com/v1/embeddings',
      apiKey: 'sk-test',
      dimensions: 1,
      fetchImpl: (async (input: string | URL | Request) => {
        url = String(input);
        return jsonResponse({ data: [{ index: 0, embedding: [1] }] });
      }) as typeof fetch,
    });
    await client.embed(['x']);
    expect(url).toBe('https://api.example.com/v1/embeddings');
  });
});
