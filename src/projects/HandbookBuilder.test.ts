import { describe, expect, it } from 'vitest';
import type {
  ProjectRecord,
  ProjectSnapshot,
  ProjectSymbol,
} from '../types/skills-plugins-projects.js';
import type { ProjectDocumentMeta } from './ProjectStore.js';
import { buildHandbook } from './HandbookBuilder.js';

const project: ProjectRecord = {
  id: 'demo',
  name: 'Demo',
  aliases: ['演示'],
  description: '演示项目',
  source: { type: 'local', path: '/srv/demo' },
  defaultBranch: 'main',
  ownerStaffIds: [],
  visibility: 'team',
  sensitivity: 'team',
  isDefault: false,
  enabled: true,
  autoSyncMinutes: 0,
  lastCommit: 'abcdef1234567890',
  handbookVersion: 0,
  lastError: '',
};

const snapshot: ProjectSnapshot = {
  id: 'snap-1',
  projectId: 'demo',
  commitSha: 'abcdef1234567890',
  branch: 'main',
  status: 'ready',
  fileCount: 5,
  totalBytes: 12_345,
  symbolCount: 2,
  chunkCount: 10,
  stats: {},
  error: '',
  startedAt: 1_000,
  finishedAt: 2_000,
};

function document(
  path: string,
  overrides: Partial<ProjectDocumentMeta> = {},
): ProjectDocumentMeta {
  return {
    path,
    language: 'typescript',
    kind: 'code',
    sizeBytes: 100,
    lineCount: 10,
    ...overrides,
  };
}

const documents: ProjectDocumentMeta[] = [
  document('src/index.ts'),
  document('src/harness/ToolRegistry.ts'),
  document('deploy/dingtalk-agent.service', { language: 'ini', kind: 'config' }),
  document('.env.example', { language: 'text', kind: 'config' }),
  document('package.json', { language: 'json', kind: 'config' }),
];

const symbols: ProjectSymbol[] = [
  {
    id: 'sym-1',
    projectId: 'demo',
    snapshotId: 'snap-1',
    path: 'src/index.ts',
    name: 'bootstrap',
    kind: 'function',
    startLine: 1,
    endLine: 20,
    signature: 'function bootstrap(): Promise<void>',
    parent: '',
    exported: true,
  },
];

const fileContents = new Map<string, string>([
  [
    'package.json',
    JSON.stringify({
      name: 'demo',
      scripts: { build: 'tsc', start: 'node dist' },
      repository: 'https://github.com/SongJok/anthys.git',
    }),
  ],
  ['.env.example', 'LLM_API_KEY=sk-secret-value\nDATABASE_URL=postgres://demo:CHANGE_ME@db\n'],
  ['deploy/dingtalk-agent.service', 'ExecStart=/usr/bin/env node dist/index.js\n'],
]);

describe('HandbookBuilder', () => {
  it('生成确定性章节，配置只保留变量名', () => {
    const content = buildHandbook({
      project,
      snapshot,
      documents,
      symbols,
      repoMapText: 'src\n  index.ts',
      fileContents,
      manualEntryCount: 2,
      now: 42,
    });
    const keys = content.sections.map((section) => section.key);
    expect(keys).toEqual(
      expect.arrayContaining(['overview', 'architecture', 'modules', 'config', 'deploy']),
    );
    expect(content.commit).toBe('abcdef1234567890');
    expect(content.generatedAt).toBe(42);

    const overview = content.sections.find((section) => section.key === 'overview');
    expect(overview?.markdown).toContain('演示项目');
    expect(overview?.markdown).toContain('人工条目：2 条');
    expect(overview?.markdown).toContain('https://github.com/SongJok/anthys');
    expect(overview?.markdown).toContain('点个 Star');
    expect(overview?.markdown).not.toContain('/srv/demo');

    const config = content.sections.find((section) => section.key === 'config');
    expect(config?.markdown).toContain('LLM_API_KEY');
    expect(config?.markdown).toContain('DATABASE_URL');
    expect(config?.markdown).not.toContain('sk-secret-value');
    expect(config?.markdown).not.toContain('postgres://demo:secret');

    const deploy = content.sections.find((section) => section.key === 'deploy');
    expect(deploy?.markdown).toContain('deploy/dingtalk-agent.service');
    expect(deploy?.markdown).toContain('`build`');
    expect(deploy?.markdown).not.toContain('ExecStart');

    const modules = content.sections.find((section) => section.key === 'modules');
    expect(modules?.markdown).toContain('src/harness');
    expect(modules?.markdown).toContain('bootstrap');
  });

  it('没有快照时跳过代码结构章节，仍保留登记信息', () => {
    const content = buildHandbook({
      project: { ...project, handbookVersion: 0 },
      snapshot: null,
      documents: [],
      symbols: [],
      repoMapText: '',
      fileContents: new Map(),
      now: 7,
    });
    const keys = content.sections.map((section) => section.key);
    expect(keys).toContain('overview');
    expect(keys).not.toContain('architecture');
    expect(keys).not.toContain('modules');
    const overview = content.sections.find((section) => section.key === 'overview');
    expect(overview?.markdown).toContain('尚未建立代码索引');
    expect(overview?.markdown).not.toContain('/srv/demo');
    expect(overview?.markdown).not.toContain('点个 Star');
  });

  it('章节来源指向快照提交', () => {
    const content = buildHandbook({
      project,
      snapshot,
      documents,
      symbols,
      repoMapText: '',
      fileContents,
    });
    const config = content.sections.find((section) => section.key === 'config');
    expect(config?.sources.every((source) => source.commit === snapshot.commitSha)).toBe(true);
    expect(config?.sources.some((source) => source.path === '.env.example')).toBe(true);
  });
});
