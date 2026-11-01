/** 模型价格以人民币计，按每百万 Token 报价；成本落库使用 1 CNY = 1e6 micros */
export interface ModelPrice {
  inputPerMTokensCny: number;
  outputPerMTokensCny: number;
  /** 命中提示缓存的输入单价；未配置时按普通输入价计 */
  cachedInputPerMTokensCny?: number;
}

interface ModelPriceEntry {
  input?: number;
  output?: number;
  cachedInput?: number;
}

export interface ModelPricingConfig {
  default?: ModelPriceEntry;
  models?: Record<string, ModelPriceEntry>;
}

export interface CostEstimate {
  costMicros: number;
  price: ModelPrice;
}

function normalizeEntry(
  raw: ModelPriceEntry,
  label: string,
): ModelPrice {
  const input = Number(raw.input);
  const output = Number(raw.output);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    throw new Error(`MODEL_PRICING_JSON 中 ${label} 的 input/output 必须是非负数`);
  }
  const cached = raw.cachedInput === undefined ? undefined : Number(raw.cachedInput);
  if (cached !== undefined && (!Number.isFinite(cached) || cached < 0)) {
    throw new Error(`MODEL_PRICING_JSON 中 ${label} 的 cachedInput 必须是非负数`);
  }
  return {
    inputPerMTokensCny: input,
    outputPerMTokensCny: output,
    ...(cached !== undefined ? { cachedInputPerMTokensCny: cached } : {}),
  };
}

/**
 * 估算模型调用成本。价格完全由部署方配置，不内置任何供应商报价，
 * 避免价格变动后账本给出看似权威的错误金额。
 */
export class ModelPricing {
  private readonly fallback?: ModelPrice;
  private readonly models = new Map<string, ModelPrice>();

  constructor(config: ModelPricingConfig = {}) {
    if (config.default) {
      this.fallback = normalizeEntry(config.default, 'default');
    }
    for (const [model, entry] of Object.entries(config.models ?? {})) {
      if (!model.trim()) continue;
      this.models.set(model.trim().toLowerCase(), normalizeEntry(entry, model));
    }
  }

  public get configured(): boolean {
    return this.fallback !== undefined || this.models.size > 0;
  }

  public priceFor(model: string): ModelPrice | undefined {
    const key = model.trim().toLowerCase();
    return this.models.get(key) ?? this.fallback;
  }

  public estimate(input: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }): CostEstimate | undefined {
    if (!this.configured) return undefined;
    const price = this.priceFor(input.model);
    if (!price) return undefined;
    if (input.inputTokens === undefined || input.outputTokens === undefined) {
      return undefined;
    }
    const inputTokens = Math.max(0, input.inputTokens);
    const outputTokens = Math.max(0, input.outputTokens);
    const cachedTokens = Math.min(inputTokens, Math.max(0, input.cachedTokens ?? 0));
    const cachedPrice =
      price.cachedInputPerMTokensCny ?? price.inputPerMTokensCny;
    // 每百万 Token 单价 P（元）× Token 数 = 成本 micros
    const raw =
      (inputTokens - cachedTokens) * price.inputPerMTokensCny +
      cachedTokens * cachedPrice +
      outputTokens * price.outputPerMTokensCny;
    return { costMicros: Math.max(0, Math.round(raw)), price };
  }
}

export function parseModelPricing(raw: string | undefined): ModelPricing {
  const text = raw?.trim();
  if (!text) return new ModelPricing();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `MODEL_PRICING_JSON 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_PRICING_JSON 必须是对象');
  }
  const record = parsed as Record<string, unknown>;
  const modelsRaw = record.models;
  if (
    modelsRaw !== undefined &&
    (modelsRaw === null || typeof modelsRaw !== 'object' || Array.isArray(modelsRaw))
  ) {
    throw new Error('MODEL_PRICING_JSON.models 必须是对象');
  }
  const defaultRaw = record.default;
  if (
    defaultRaw !== undefined &&
    (defaultRaw === null || typeof defaultRaw !== 'object' || Array.isArray(defaultRaw))
  ) {
    throw new Error('MODEL_PRICING_JSON.default 必须是对象');
  }
  return new ModelPricing({
    ...(defaultRaw ? { default: defaultRaw as ModelPriceEntry } : {}),
    ...(modelsRaw
      ? { models: modelsRaw as Record<string, ModelPriceEntry> }
      : {}),
  });
}

export function formatCny(costMicros: number): string {
  return `¥${(costMicros / 1_000_000).toFixed(4)}`;
}
