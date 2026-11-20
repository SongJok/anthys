import { describe, expect, it } from 'vitest';
import { ContextAssembler } from './ContextAssembler.js';
import type { StoredMessage } from '../types/core.js';

const persona = {
  name: '小钉',
  rolePrompt: '你是企业内部的研发助手。',
  speakingStyle: '先结论后要点。',
};

const fixedNow = () => Date.UTC(2026, 9, 30, 2, 0, 0);

function historyMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
): StoredMessage {
  return {
    id,
    role,
    content,
    reasoning: null,
    createdAt: Date.UTC(2026, 9, 30, 1, 0, 0),
  };
}

describe('ContextAssembler', () => {
  it('注入人设、工具规范与当前时间', () => {
    const assembler = new ContextAssembler({
      windowMessages: 20,
      now: fixedNow,
    });
    const messages = assembler.build({
      persona,
      history: [],
      userText: '你好',
    });

    expect(messages).toHaveLength(3);
    const system = messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('小钉');
    expect(system?.content).toContain('研发助手');
    expect(system?.content).toContain('先结论后要点');
    expect(system?.content).toContain('优先调用可用工具');
    expect(system?.content).toContain('未标记错误的工具返回就是真实数据');
    const tail = messages[1];
    expect(tail?.role).toBe('system');
    expect(tail?.content).toContain('当前时间（Asia/Shanghai，UTC+08:00）');
    expect(tail?.content).toContain('今天是 2026-10-30（周五）');
    expect(tail?.content).toContain('明天是 2026-10-31（周六）');
    expect(tail?.content).toContain('只在其消息标注的日期成立');
    expect(messages[2]).toEqual({ role: 'user', content: '你好' });
  });

  it('易变时钟与记忆放在历史之后，稳定前缀跨轮逐字节一致', () => {
    let clock = Date.UTC(2026, 9, 30, 2, 0, 0);
    const assembler = new ContextAssembler({
      windowMessages: 20,
      now: () => clock,
    });
    const history = [
      historyMessage('m1', 'user', '第一句'),
      historyMessage('m2', 'assistant', '第一答'),
    ];
    const first = assembler.build({ persona, history, userText: '第二句' });

    clock += 61_000;
    const second = assembler.build({
      persona,
      history: [
        ...history,
        historyMessage('m3', 'user', '第二句'),
        historyMessage('m4', 'assistant', '第二答'),
      ],
      userText: '第三句',
    });

    expect(second[0]).toEqual(first[0]);
    expect(second.slice(1, 3)).toEqual(first.slice(1, 3));
    expect(second[1]?.content).not.toContain('当前时间');
    const firstTail = first[first.length - 2]?.content ?? '';
    const secondTail = second[second.length - 2]?.content ?? '';
    expect(firstTail).not.toBe(secondTail);
    expect(secondTail).toContain('2026-10-30 10:01');
  });

  it('三层记忆随易变尾部注入，不污染稳定前缀', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      history: [],
      userText: '他是谁',
      memoryContext: {
        personaSystemPrompt: '你是小钉',
        userSemanticProfile: '张三，后端工程师',
        groupRecentTranscript: '',
        episodicSummary: '上次讨论过部署',
        activeTurnMessages: [],
      },
    });
    expect(messages[0]?.content).toBe('你是小钉');
    const tail = messages[1]?.content ?? '';
    expect(tail).toContain('## 三层记忆上下文');
    expect(tail).toContain('张三，后端工程师');
    expect(tail).toContain('上次讨论过部署');
    expect(tail).toContain('当前时间（Asia/Shanghai');
  });

  it('术语卡等附加指令移到历史后易变尾部，头部稳定前缀仍保留术语优先指令', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      history: [],
      userText: 'CQ 是什么',
      extraSystemPrompt: '## 企业术语知识库\n- CQ：变更请求单',
    });

    expect(messages).toHaveLength(3);
    const system = messages[0]?.content ?? '';
    expect(system).toContain('小钉');
    expect(system).toContain('先查公司术语');
    expect(system).not.toContain('## 企业术语知识库');
    expect(system).not.toContain('CQ：变更请求单');
    const tail = messages[1]?.content ?? '';
    expect(tail).toContain('## 企业术语知识库');
    expect(tail).toContain('CQ：变更请求单');
    expect(tail).toContain('当前时间（Asia/Shanghai');
    expect(messages[2]).toEqual({ role: 'user', content: 'CQ 是什么' });
  });

  it('术语卡随问题变化时稳定前缀与历史逐字节一致，不击穿缓存', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const history = [
      historyMessage('m1', 'user', '第一句'),
      historyMessage('m2', 'assistant', '第一答'),
    ];
    const first = assembler.build({
      persona,
      history,
      userText: 'CQ 是什么',
      extraSystemPrompt: '## 企业术语知识库\n- CQ：变更请求单',
    });
    const second = assembler.build({
      persona,
      history: [
        ...history,
        historyMessage('m3', 'user', 'CQ 是什么'),
        historyMessage('m4', 'assistant', 'CQ 是变更请求单'),
      ],
      userText: 'PO 又是什么',
      extraSystemPrompt: '## 企业术语知识库\n- PO：采购订单',
    });

    expect(second[0]).toEqual(first[0]);
    expect(second.slice(1, 3)).toEqual(first.slice(1, 3));
    const firstTail = first[first.length - 2]?.content ?? '';
    const secondTail = second[second.length - 2]?.content ?? '';
    expect(firstTail).toContain('CQ：变更请求单');
    expect(secondTail).toContain('PO：采购订单');
    expect(secondTail).not.toContain('CQ：变更请求单');
  });

  it('按窗口截断历史并保持原有顺序', () => {
    const assembler = new ContextAssembler({
      windowMessages: 2,
      now: fixedNow,
    });
    const history = [
      historyMessage('m1', 'user', '第一句'),
      historyMessage('m2', 'assistant', '第一答'),
      historyMessage('m3', 'user', '第二句'),
      historyMessage('m4', 'assistant', '第二答'),
    ];
    const messages = assembler.build({
      persona,
      history,
      userText: '第三句',
    });

    const conversational = messages.filter((m) => m.role !== 'system');
    expect(conversational).toEqual([
      { role: 'user', content: '[2026-10-30 09:00 周五] 第二句' },
      { role: 'assistant', content: '[2026-10-30 09:00 周五] 第二答' },
      { role: 'user', content: '第三句' },
    ]);
  });

  it('窗口参数小于 1 时至少保留一条历史', () => {
    const assembler = new ContextAssembler({ windowMessages: 0, now: fixedNow });
    const messages = assembler.build({
      persona,
      history: [
        historyMessage('m1', 'user', '旧问题'),
        historyMessage('m2', 'assistant', '旧回答'),
      ],
      userText: '新问题',
    });
    expect(messages.map((m) => m.content)).toEqual([
      expect.stringContaining('小钉'),
      '[2026-10-30 09:00 周五] 旧回答',
      expect.stringContaining('当前时间（Asia/Shanghai'),
      '新问题',
    ]);
  });

  it('群聊场景为历史与当前发言加上发言人前缀', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      groupChat: true,
      userSpeaker: '李四',
      history: [
        {
          id: 'u1',
          role: 'user',
          content: '部署失败了吗',
          senderNick: '张三',
          reasoning: null,
          createdAt: 0,
        },
        historyMessage('a1', 'assistant', '正在排查'),
      ],
      userText: '看下日志',
    });

    expect(messages[1]).toEqual({ role: 'user', content: '张三：部署失败了吗' });
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '[2026-10-30 09:00 周五] 正在排查',
    });
    expect(messages[4]).toEqual({ role: 'user', content: '李四：看下日志' });
  });

  it('单聊场景不添加发言人前缀', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      userSpeaker: '李四',
      history: [
        {
          id: 'u1',
          role: 'user',
          content: '部署失败了吗',
          senderNick: '张三',
          reasoning: null,
          createdAt: 0,
        },
      ],
      userText: '看下日志',
    });
    expect(messages[1]).toEqual({ role: 'user', content: '部署失败了吗' });
    expect(messages[3]).toEqual({ role: 'user', content: '看下日志' });
  });

  it('不把 assistant 的内部思维链注入后续上下文', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      history: [
        {
          id: 'a1',
          role: 'assistant',
          content: '公开答案',
          reasoning: '内部推理不应出现',
          createdAt: 0,
        },
      ],
      userText: '追问',
    });
    expect(JSON.stringify(messages)).not.toContain('内部推理不应出现');
    expect(messages[1]).toEqual({ role: 'assistant', content: '公开答案' });
  });

  it('清洗历史中的二次确认提示并去除重复时间戳前缀', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      history: [
        historyMessage(
          'a1',
          'assistant',
          '[2026-11-07 16:04 周六] 操作需要确认：机器人准备调用工具 `personal_reminder_manage`（写操作）。\n回复「确认」执行',
        ),
      ],
      userText: '确认更换',
    });
    expect(messages[1]?.content).toContain('[2026-10-30 09:00 周五]');
    expect(messages[1]?.content).not.toContain('操作需要确认：机器人准备调用工具');
    expect(messages[1]?.content).toContain('真实发起对应的 tool_calls');
  });

  it('按会话类型覆盖历史窗口：单聊最多近 10 条', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const history = Array.from({ length: 15 }, (_, i) =>
      historyMessage(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `消息${i}`),
    );
    const messages = assembler.build({
      persona,
      history,
      userText: '新问题',
      windowMessages: 10,
    });
    const conversational = messages.filter((m) => m.role !== 'system');
    expect(conversational).toHaveLength(11);
    expect(conversational[0]?.content).toContain('消息5');
  });

  it('窗口覆盖可大于构造默认值：群聊最多近 20 条', () => {
    const assembler = new ContextAssembler({ windowMessages: 10, now: fixedNow });
    const history = Array.from({ length: 25 }, (_, i) =>
      historyMessage(`m${i}`, 'user', `消息${i}`),
    );
    const messages = assembler.build({
      persona,
      history,
      userText: '新问题',
      windowMessages: 20,
    });
    const conversational = messages.filter((m) => m.role !== 'system');
    expect(conversational).toHaveLength(21);
    expect(conversational[0]?.content).toContain('消息5');
  });

  it('注入新闻多源交叉核实与上下文反驳引导', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const system =
      assembler.build({ persona, history: [], userText: '新闻' })[0]?.content ?? '';
    expect(system).toContain('多角度获取');
    expect(system).toContain('交叉比对多个独立来源');
    expect(system).toContain('增加反驳或纠正观点');
  });

  it('历史滞回裁剪：锚点稳定期内首条历史不变，滑出后一次性回裁', () => {
    const assembler = new ContextAssembler({ windowMessages: 4, now: fixedNow });
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        historyMessage(`m${i + 1}`, i % 2 === 0 ? 'user' : 'assistant', `消息${i + 1}`),
      );
    const key = 'conv-1';
    const first = assembler.build({
      persona,
      history: make(4),
      conversationKey: key,
      userText: '问1',
    });
    const grown = assembler.build({
      persona,
      history: make(10),
      conversationKey: key,
      userText: '问2',
    });
    // 锚点 m1 仍在取数集合内：首条历史与稳定前缀逐字节一致
    expect(grown[0]).toEqual(first[0]);
    expect(grown[1]).toEqual(first[1]);
    expect(grown[1]?.content).toContain('消息1');

    // 取数集合滑动到 m3..m16（m1 滑出）：回裁到最近 4 条并重新锚定
    const slid = Array.from({ length: 14 }, (_, i) =>
      historyMessage(`m${i + 3}`, i % 2 === 0 ? 'user' : 'assistant', `消息${i + 3}`),
    );
    const trimmed = assembler.build({
      persona,
      history: slid,
      conversationKey: key,
      userText: '问3',
    });
    const conversational = trimmed.filter((m) => m.role !== 'system');
    expect(conversational).toHaveLength(5);
    expect(conversational[0]?.content).toContain('消息13');
  });

  it('无 conversationKey 时退化为普通窗口截断', () => {
    const assembler = new ContextAssembler({ windowMessages: 2, now: fixedNow });
    const history = Array.from({ length: 6 }, (_, i) =>
      historyMessage(`m${i}`, 'user', `消息${i}`),
    );
    const messages = assembler.build({ persona, history, userText: '新' });
    const conversational = messages.filter((m) => m.role !== 'system');
    expect(conversational).toHaveLength(3);
    expect(conversational[0]?.content).toContain('消息4');
  });

  it('历史 assistant 回复截断到约 600 字，用户发言保留全文', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const longAnswer = '答'.repeat(900);
    const longQuestion = '问'.repeat(900);
    const messages = assembler.build({
      persona,
      history: [
        historyMessage('u1', 'user', longQuestion),
        historyMessage('a1', 'assistant', longAnswer),
      ],
      userText: '追问',
    });
    const userMsg = messages[1]?.content ?? '';
    const assistantMsg = messages[2]?.content ?? '';
    expect(userMsg).toContain(longQuestion);
    expect(assistantMsg).toContain('答'.repeat(600));
    expect(assistantMsg).not.toContain('答'.repeat(601));
    expect(assistantMsg.endsWith('…')).toBe(true);
  });
});
