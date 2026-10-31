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

    expect(messages).toHaveLength(2);
    const system = messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('小钉');
    expect(system?.content).toContain('研发助手');
    expect(system?.content).toContain('先结论后要点');
    expect(system?.content).toContain('优先调用可用工具');
    expect(system?.content).toContain('未标记错误的工具返回就是真实数据');
    expect(system?.content).toContain('当前时间：');
    expect(messages[1]).toEqual({ role: 'user', content: '你好' });
  });

  it('把术语库等额外系统提示合并到同一条 system 消息', () => {
    const assembler = new ContextAssembler({ windowMessages: 20, now: fixedNow });
    const messages = assembler.build({
      persona,
      history: [],
      userText: 'CQ 是什么',
      extraSystemPrompt: '## 企业术语知识库\n- CQ：变更请求单',
    });

    expect(messages).toHaveLength(2);
    const system = messages[0]?.content ?? '';
    expect(system).toContain('小钉');
    expect(system).toContain('## 企业术语知识库');
    expect(system).toContain('CQ：变更请求单');
    expect(messages[1]).toEqual({ role: 'user', content: 'CQ 是什么' });
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
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '第二答' },
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
      '旧回答',
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
    expect(messages[2]).toEqual({ role: 'assistant', content: '正在排查' });
    expect(messages[3]).toEqual({ role: 'user', content: '李四：看下日志' });
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
    expect(messages[2]).toEqual({ role: 'user', content: '看下日志' });
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
});
