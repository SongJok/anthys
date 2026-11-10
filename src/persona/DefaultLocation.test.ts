import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCATION,
  buildDefaultLocationPrompt,
  resolveDefaultLocation,
} from './DefaultLocation.js';

describe('resolveDefaultLocation', () => {
  it('未配置时用代码默认值', () => {
    expect(resolveDefaultLocation({})).toEqual(DEFAULT_LOCATION);
  });

  it('环境变量覆盖地址与坐标', () => {
    const location = resolveDefaultLocation({
      DEFAULT_LOCATION_ADDRESS: '北京市朝阳区望京SOHO',
      DEFAULT_LOCATION_CITY: '北京市',
      DEFAULT_LOCATION_LONGITUDE: '116.470293',
      DEFAULT_LOCATION_LATITUDE: '39.996171',
    });
    expect(location.address).toBe('北京市朝阳区望京SOHO');
    expect(location.longitude).toBeCloseTo(116.470293, 6);
    expect(location.latitude).toBeCloseTo(39.996171, 6);
  });

  it('坐标非法时回退默认坐标', () => {
    const location = resolveDefaultLocation({
      DEFAULT_LOCATION_LONGITUDE: 'not-a-number',
    });
    expect(location.longitude).toBe(DEFAULT_LOCATION.longitude);
    expect(location.latitude).toBe(DEFAULT_LOCATION.latitude);
  });
});

describe('buildDefaultLocationPrompt', () => {
  it('提示里带地址与坐标，并说明未指明地点时用默认位置', () => {
    const prompt = buildDefaultLocationPrompt(DEFAULT_LOCATION);
    expect(prompt).toContain('北京市石景山区鲁谷大街瑞达大厦');
    expect(prompt).toContain('116.245261');
    expect(prompt).toContain('39.903114');
    expect(prompt).toContain('附近/周边');
  });
});
