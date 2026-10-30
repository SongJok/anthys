/** 轻量 Prometheus 文本指标：计数器 + 仪表盘，不引入额外依赖 */

type Labels = Record<string, string>;

function labelKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const rendered = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key]}"`)
    .join(',');
  return `${name}{${rendered}}`;
}

function metricName(key: string): string {
  const index = key.indexOf('{');
  return index >= 0 ? key.slice(0, index) : key;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  public inc(name: string, labels?: Labels, value = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  public set(name: string, value: number, labels?: Labels): void {
    this.gauges.set(labelKey(name, labels), value);
  }

  public get(name: string, labels?: Labels): number {
    const key = labelKey(name, labels);
    return this.counters.get(key) ?? this.gauges.get(key) ?? 0;
  }

  public render(extra?: string): string {
    const lines: string[] = ['# HELP dingtalk_agent_metrics DingTalk agent runtime metrics'];
    const counters = [...this.counters.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [key, value] of counters) {
      lines.push(`# TYPE ${metricName(key)} counter`);
      lines.push(`${key} ${value}`);
    }
    const gauges = [...this.gauges.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [key, value] of gauges) {
      lines.push(`# TYPE ${metricName(key)} gauge`);
      lines.push(`${key} ${value}`);
    }
    if (extra?.trim()) lines.push(extra.trim());
    return `${lines.join('\n')}\n`;
  }
}
