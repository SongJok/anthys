export interface EmbeddingClient {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface OpenAIEmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

/** 复用 OpenAI 兼容的 /embeddings 接口，供 pgvector 语义召回 */
export class OpenAIEmbeddingClient implements EmbeddingClient {
  public readonly dimensions: number;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIEmbeddingOptions) {
    this.dimensions = options.dimensions ?? 1536;
    this.model = options.model ?? 'text-embedding-3-small';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base = options.baseUrl.replace(/\/+$/u, '');
    this.endpoint = base.endsWith('/embeddings')
      ? base
      : `${base}/embeddings`;
  }

  public async embed(texts: string[]): Promise<number[][]> {
    const inputs = texts.map((text) => text.trim()).filter(Boolean);
    if (inputs.length === 0) return [];
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
        dimensions: this.dimensions,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status}`);
    }
    const payload = (await response.json()) as EmbeddingResponse;
    const rows = payload.data ?? [];
    if (rows.length !== inputs.length) {
      throw new Error(
        `embedding response size mismatch: ${rows.length}/${inputs.length}`,
      );
    }
    return rows
      .slice()
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((row) => {
        const embedding = row.embedding ?? [];
        if (embedding.length !== this.dimensions) {
          throw new Error(
            `embedding dimension mismatch: ${embedding.length}/${this.dimensions}`,
          );
        }
        return embedding;
      });
  }
}
