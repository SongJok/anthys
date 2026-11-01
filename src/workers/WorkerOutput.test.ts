import { describe, expect, it } from 'vitest';
import { parseWorkerOutput } from './WorkerOutput.js';

describe('parseWorkerOutput', () => {
  it('解析完整 JSON 并归一化字符串形式的发现与动作', () => {
    const output = parseWorkerOutput(
      JSON.stringify({
        status: 'completed',
        summary: '网关超时已定位',
        findings: [
          '网关超时阈值为 3 秒',
          { claim: '错误集中在 10:00-11:00', source: 'https://log.example.com' },
        ],
        actions: ['已导出一份日志'],
        sources: ['https://log.example.com'],
        openQuestions: ['是否需要调整网关配置'],
      }),
    );
    expect(output).toEqual({
      status: 'completed',
      summary: '网关超时已定位',
      findings: [
        { claim: '网关超时阈值为 3 秒' },
        { claim: '错误集中在 10:00-11:00', source: 'https://log.example.com' },
      ],
      actions: [{ action: '已导出一份日志' }],
      sources: ['https://log.example.com'],
      openQuestions: ['是否需要调整网关配置'],
    });
  });

  it('支持代码围栏与 JSON 前后夹杂说明', () => {
    expect(
      parseWorkerOutput('结论如下：\n```json\n{"summary":"完成","status":"partial"}\n```\n以上。')
        ?.summary,
    ).toBe('完成');
    expect(
      parseWorkerOutput('先给结论 {"summary":"已汇总","status":"blocked"} 谢谢')
        ?.status,
    ).toBe('blocked');
  });

  it('缺少 summary、非法 JSON 或非对象时回退 null', () => {
    expect(parseWorkerOutput('这里是普通文本结论')).toBeNull();
    expect(parseWorkerOutput('{"status":"completed","findings":[]}')).toBeNull();
    expect(parseWorkerOutput('{"summary":')).toBeNull();
    expect(parseWorkerOutput('[1,2,3]')).toBeNull();
  });

  it('未知状态归一化为 partial，缺省数组补空', () => {
    const output = parseWorkerOutput('{"summary":"部分完成","status":"unknown"}');
    expect(output).toEqual({
      status: 'partial',
      summary: '部分完成',
      findings: [],
      actions: [],
      sources: [],
      openQuestions: [],
    });
  });
});
