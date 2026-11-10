/**
 * 机器人默认所在位置。
 * 用户问「附近/周边」而没指明地点时，以这里为坐标中心；可用环境变量覆盖，便于迁移部署。
 */
export interface DefaultLocation {
  address: string;
  city: string;
  longitude: number;
  latitude: number;
}

export const DEFAULT_LOCATION: DefaultLocation = {
  address: '北京市石景山区鲁谷大街瑞达大厦',
  city: '北京市',
  longitude: 116.245261,
  latitude: 39.903114,
};

export function resolveDefaultLocation(
  env: Record<string, string | undefined> = process.env,
): DefaultLocation {
  const longitude = Number(env['DEFAULT_LOCATION_LONGITUDE']);
  const latitude = Number(env['DEFAULT_LOCATION_LATITUDE']);
  return {
    address: env['DEFAULT_LOCATION_ADDRESS']?.trim() || DEFAULT_LOCATION.address,
    city: env['DEFAULT_LOCATION_CITY']?.trim() || DEFAULT_LOCATION.city,
    longitude: Number.isFinite(longitude)
      ? longitude
      : DEFAULT_LOCATION.longitude,
    latitude: Number.isFinite(latitude) ? latitude : DEFAULT_LOCATION.latitude,
  };
}

/** 注入系统提示的默认位置说明，避免模型自己猜「我在哪」 */
export function buildDefaultLocationPrompt(location: DefaultLocation): string {
  return [
    '默认位置：',
    `- 你部署在「${location.address}」（${location.city}，经度 ${location.longitude}，纬度 ${location.latitude}，GCJ-02 坐标系）。`,
    '- 用户问「附近/周边/就近/周围/怎么过去」而没有指明地点时，默认以该位置为坐标中心；用户明确说了别的地点就以用户说的为准。',
  ].join('\n');
}
