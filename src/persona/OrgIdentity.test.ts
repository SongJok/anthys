import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../memory/ContextAssembler.js';
import {
  buildOrgIdentityPrompt,
  DEFAULT_ADMIN_NAME,
  DEFAULT_ORG_NAME,
  resolveOrgIdentity,
} from './OrgIdentity.js';

describe('OrgIdentity', () => {
  it('默认组织与管理员', () => {
    expect(resolveOrgIdentity({})).toEqual({
      orgName: DEFAULT_ORG_NAME,
      adminName: 'Joony',
    });
    expect(DEFAULT_ADMIN_NAME).toBe('Joony');
  });

  it('环境变量可覆盖', () => {
    expect(
      resolveOrgIdentity({ ORG_NAME: ' 某公司 ', BOT_ADMIN_NAME: 'Amy' }),
    ).toEqual({ orgName: '某公司', adminName: 'Amy' });
  });

  it('提示词包含组织、管理员与主动指引', () => {
    const prompt = buildOrgIdentityPrompt(resolveOrgIdentity({}));
    expect(prompt).toContain('北京陶乐科技有限公司');
    expect(prompt).toContain('联系管理员 Joony');
    expect(prompt).toContain('内部员工/同事');
    expect(prompt).toContain('严禁站在外部求职');
  });

  it('系统提示默认携带组织与管理员信息', () => {
    const prompt = buildSystemPrompt({
      name: '小助手',
      rolePrompt: 'r',
      speakingStyle: 's',
    });
    expect(prompt).toContain('Joony');
    expect(prompt).toContain('北京陶乐科技有限公司');
  });

  it('系统提示携带默认位置', () => {
    const prompt = buildSystemPrompt({
      name: '小助手',
      rolePrompt: 'r',
      speakingStyle: 's',
    });
    expect(prompt).toContain('北京市石景山区鲁谷大街瑞达大厦');
    expect(prompt).toContain('默认位置');
  });
});
