import { describe, expect, it } from 'vitest';
import { detectStopIntent } from './StopIntent.js';

describe('detectStopIntent', () => {
  it('命中常见的停止/暂停/关闭整句指令', () => {
    const positives = [
      '停止',
      '停',
      '停下',
      '停下来',
      '停一下',
      '暂停',
      '暂停一下',
      '关闭',
      '终止',
      '中止',
      '打住',
      '停手',
      '停止吧',
      '停了',
      '别跑了',
      '别做了',
      '别查了',
      '别搜了',
      '别回答了',
      '别继续了',
      '不跑了',
      '不做了',
      '不用查了',
      '停止任务',
      '停止当前任务',
      '停止这个任务',
      '暂停任务',
      '关闭任务',
      '关闭当前任务',
      '终止任务',
      '停止回答',
      '停止执行',
      '停止运行',
      '取消任务',
      '取消当前任务',
      '取消执行',
      '把任务停了',
      '把这个任务停止',
      '把它关了',
      '先停一下',
      '请停止',
      '帮我停止当前任务',
      '麻烦暂停一下',
      '机器人停止',
      '现在立刻停止',
      '停 止',
      '停止 任务',
      '「停止」',
      '停止！',
      'stop',
      'Stop!',
      'PAUSE',
      'cancel',
    ];
    for (const text of positives) {
      expect(detectStopIntent(text), `应命中: ${text}`).toBe(true);
    }
  });

  it('剥离行首 @提及后仍能命中', () => {
    expect(detectStopIntent('@小钉 停止')).toBe(true);
    expect(detectStopIntent('@小钉 停止当前任务')).toBe(true);
    expect(detectStopIntent('@bot @bot 暂停')).toBe(true);
  });

  it('不把正常需求/问题误判为停止指令', () => {
    const negatives = [
      '',
      '   ',
      '你好',
      '知道了',
      '了解了',
      '不用了',
      '算了',
      '不要',
      '如何停止一个进程',
      '怎么暂停线程',
      '帮我写一个关闭按钮',
      '停止下载是什么意思',
      '关闭写权限',
      '关闭旁听',
      '关闭群旁听',
      '帮我关闭这个 GitHub issue',
      '停止词有哪些',
      '请帮我查一下明天的天气',
      '再查一下',
      '继续',
      '继续执行',
      '暂停一下我再想想这个方案怎么做',
      '取消',
    ];
    for (const text of negatives) {
      expect(detectStopIntent(text), `不应命中: ${text}`).toBe(false);
    }
  });
});