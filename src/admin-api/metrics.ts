import type { AgentStreamEvent } from '../types/core.js';

/** 轻量 Prometheus 文本指标：计数器 + 仪表盘，不引入额外依赖 */

type Labels = Record<string, string>;

function escapeLabelValue(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function labelKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const rendered = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabelValue(labels[key])}"`)
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

/** 统一记录主运行、规划器、子代理及 Prompt Caching 指标，避免各入口重复埋点 */
export function recordStreamEventMetrics(
  metrics: MetricsRegistry,
  event: AgentStreamEvent,
): void {
  metrics.inc('agent_events_total', { type: event.type });
  if (event.type === 'tool_start') {
    metrics.inc('agent_tool_calls_total');
    return;
  }
  if (event.type === 'plan' && event.initial) {
    metrics.inc('agent_planner_runs_total');
    return;
  }
  if (event.type === 'tool_end' && event.traces?.length) {
    for (const trace of event.traces) {
      if (trace.kind === 'subagent') {
        metrics.inc('agent_subagent_calls_total', { name: trace.name });
      }
    }
    return;
  }
  if (event.type === 'error') {
    metrics.inc('agent_errors_total');
    return;
  }
  if (event.type === 'completed') {
    metrics.inc('agent_tokens_total', undefined, event.usage.totalTokens);
    if ((event.usage.cachedTokens ?? 0) > 0) {
      metrics.inc('agent_cached_tokens_total', undefined, event.usage.cachedTokens!);
    }
  }
}
