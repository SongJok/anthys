import { describe, expect, it } from 'vitest';
import { ModelPricing, formatCny, parseModelPricing } from './ModelPricing.js';

describe('ModelPricing', () => {
  it('按模型单价与缓存价估算成本 micros', () => {
    const pricing = new ModelPricing({
      default: { input: 2, output: 8, cachedInput: 0.5 },
      models: { 'glm-5.3-flash': { input: 1, output: 4 } },
    });
    const estimate = pricing.estimate({
      model: 'GLM-5.3-Flash',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedTokens: 200_000,
    });
    // 800k × 1 + 200k × 1（未单独配置缓存价）+ 500k × 4 = 3,000,000 micros
    expect(estimate?.costMicros).toBe(3_000_000);
    expect(formatCny(3_000_000)).toBe('¥3.0000');
  });

  it('命中缓存时使用缓存单价', () => {
    const pricing = new ModelPricing({
      models: { m: { input: 10, output: 20, cachedInput: 1 } },
    });
    expect(
      pricing.estimate({
        model: 'm',
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 40,
      })?.costMicros,
    ).toBe(60 * 10 + 40 * 1 + 10 * 20);
  });

  it('未知模型与缺少拆分时不返回成本，避免伪造金额', () => {
    const pricing = new ModelPricing({
      models: { m: { input: 1, output: 2 } },
    });
    expect(pricing.estimate({ model: 'other', inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    expect(pricing.estimate({ model: 'm', inputTokens: 10 })).toBeUndefined();
  });

  it('解析环境变量 JSON，并在格式非法时明确报错', () => {
    const pricing = parseModelPricing(
      '{"default":{"input":1,"output":2},"models":{"m":{"input":0,"output":0}}}',
    );
    expect(pricing.configured).toBe(true);
    expect(
      pricing.estimate({ model: 'm', inputTokens: 100, outputTokens: 100 })?.costMicros,
    ).toBe(0);
    expect(() => parseModelPricing('{bad json')).toThrow(/MODEL_PRICING_JSON/);
    expect(() =>
      parseModelPricing('{"default":{"input":-1,"output":2}}'),
    ).toThrow(/非负数/);
    expect(parseModelPricing('').configured).toBe(false);
  });
});
