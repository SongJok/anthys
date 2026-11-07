import { describe, expect, it } from 'vitest';
import {
  DwsGroupDirectorySource,
  parseDwsGroupBotsJson,
  parseDwsGroupListJson,
} from './DwsGroupDirectorySource.js';

describe('DwsGroupDirectorySource', () => {
  it('解析 dws chat +chat-list-all 输出并按 conversationId 去重', () => {
    const raw = JSON.stringify({
      groups: [
        { name: '一个亿的小目标', openConversationId: 'cid-1' },
        { name: '', openConversationId: 'cid-1' },
        { title: '点仔服务群', conversationId: 'cid-2' },
      ],
    });
    expect(parseDwsGroupListJson(raw)).toEqual([
      { conversationId: 'cid-1', name: '一个亿的小目标' },
      { conversationId: 'cid-2', name: '点仔服务群' },
    ]);
  });

  it('解析 dws chat +chat-bots 输出并去重', () => {
    const raw = JSON.stringify({
      bots: [
        { name: '点仔', openBotId: 'bot-2' },
        { name: 'AI小钉', openBotId: 'bot-1' },
        { name: '点仔', openBotId: 'bot-2' },
      ],
    });
    expect(parseDwsGroupBotsJson(raw)).toEqual([
      { name: '点仔', openBotId: 'bot-2' },
      { name: 'AI小钉', openBotId: 'bot-1' },
    ]);
  });

  it('通过 runner 拉取群列表及群内机器人，无需落盘 JSON 文件', async () => {
    const calls: string[][] = [];
    const source = new DwsGroupDirectorySource({
      concurrency: 2,
      runner: async (_bin, args) => {
        calls.push(args);
        if (args.includes('+chat-list-all')) {
          return JSON.stringify({
            groups: [
              { name: '一个亿的小目标', openConversationId: 'cid-1' },
              { name: '点仔服务群', openConversationId: 'cid-2' },
            ],
          });
        }
        const cidIdx = args.indexOf('--group');
        const cid = cidIdx >= 0 ? args[cidIdx + 1] : '';
        if (cid === 'cid-1') {
          return JSON.stringify([
            { name: '点仔', openBotId: 'bot-dianzai' },
            { name: '预警', openBotId: 'bot-alert' },
          ]);
        }
        return '[]';
      },
    });

    const groups = await source.fetchGroups({ includeBots: true });
    expect(groups).toEqual([
      {
        conversationId: 'cid-1',
        name: '一个亿的小目标',
        bots: [
          { name: '点仔', openBotId: 'bot-dianzai' },
          { name: '预警', openBotId: 'bot-alert' },
        ],
      },
      {
        conversationId: 'cid-2',
        name: '点仔服务群',
        bots: [],
      },
    ]);
    expect(calls).toHaveLength(3);
  });
});
