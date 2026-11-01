import type {
  HandbookContent,
  HandbookSection,
  HandbookSource,
  ProjectRecord,
  ProjectSnapshot,
  ProjectSymbol,
} from '../types/skills-plugins-projects.js';
import { HANDBOOK_SECTION_TITLES } from '../types/skills-plugins-projects.js';
import type { ProjectDocumentMeta } from './ProjectStore.js';

const MAX_SECTION_CHARS = 8_000;
const EXCERPT_CHARS = 1_500;

const ENTRY_PATTERN =
  /(^|\/)(index|main|server|app|cli)\.(ts|tsx|js|mjs|cjs|py|go|rs|java)$/iu;
const TEST_FILE_PATTERN =
  /(\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$|_test\.(go|py)$|Tests?\.(java|cs)$)/iu;
const DOC_FILE_PATTERN = /\.(md|mdx|rst|txt)$/iu;
const SCHEMA_PATTERN =
  /(^|\/)(schema|schemas|migrations?|entities|models|db)(\/|\.|$)/iu;
const DEPLOY_PATTERN =
  /(^(deploy|deployment|ops|infra)\/|^(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile)$|(^|\/)[^/]+\.(service|conf)$|^\.github\/workflows\/)/iu;
const OPERATIONS_PATTERN =
  /(^|\/)(operations?|runbook|oncall|monitoring|troubleshoot|运维)(\/|\.|$)/iu;
const CONVENTIONS_PATTERN =
  /(^|\/)(AGENTS|CLAUDE|CONTRIBUTING)\.md$|(^|\/)(conventions?|style)(\/|\.|$)|^(tsconfig|eslint|prettier|biome)[^/]*\.(json|js|mjs|cjs|ya?ml)$/iu;
const DECISION_PATTERN =
  /(^|\/)(adr|decisions?|design)(\/|\.|$)|(decisions?|adr|design)/iu;
const FAQ_PATTERN = /faq|常见问题/iu;
const README_PATTERN = /^README(\.[^/]*)?$/iu;
const ENV_FILE_PATTERN = /(^|\/)\.env(\.example|\.sample|\.template)?$/iu;
const CONFIG_FILE_PATTERN = /(^|\/)(config|conf)\/[^/]+$/iu;

export interface HandbookBuildInput {
  project: ProjectRecord;
  snapshot: ProjectSnapshot | null;
  documents: ProjectDocumentMeta[];
  symbols: ProjectSymbol[];
  repoMapText: string;
  fileContents: Map<string, string>;
  manualEntryCount?: number;
  now?: number;
}

interface PackageInfo {
  path: string;
  name: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function excerpt(text: string, maxChars = EXCERPT_CHARS): string {
  const normalized = text.replace(/\r\n/gu, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function clipSection(markdown: string): string {
  if (markdown.length <= MAX_SECTION_CHARS) return markdown;
  return `${markdown.slice(0, MAX_SECTION_CHARS).trimEnd()}…（章节已截断）`;
}

function sourceOf(
  path: string | undefined,
  commit: string,
  note?: string,
): HandbookSource {
  return {
    ...(path ? { path } : {}),
    ...(commit ? { commit } : {}),
    ...(note ? { note } : {}),
  };
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '.' : path.slice(0, index);
}

function topDirOf(path: string): string {
  const index = path.indexOf('/');
  return index < 0 ? '.' : path.slice(0, index);
}

function groupKeyOf(path: string): string {
  if (!path.startsWith('src/')) return topDirOf(path);
  const segments = path.split('/');
  return segments.length > 2 ? `${segments[0]}/${segments[1]}` : 'src';
}

function markdownHeadings(text: string, limit = 12): string[] {
  return text
    .split('\n')
    .filter((line) => /^#{1,4}\s+\S/u.test(line))
    .map((line) => line.replace(/^#{1,4}\s+/u, '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function repoLineOf(project: ProjectRecord): string {
  if (project.source.type === 'github') {
    return `https://github.com/${project.source.repo}`;
  }
  if (project.source.type === 'local') {
    return `本地路径 \`${project.source.path}\``;
  }
  return '仅手册项目（无代码仓库）';
}

function packageInfoOf(files: Map<string, string>): PackageInfo | null {
  const raw = files.get('package.json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scriptsRaw =
      parsed['scripts'] && typeof parsed['scripts'] === 'object'
        ? (parsed['scripts'] as Record<string, unknown>)
        : {};
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(scriptsRaw)) {
      if (typeof value === 'string') scripts[key] = value;
    }
    const depsRaw =
      parsed['dependencies'] && typeof parsed['dependencies'] === 'object'
        ? Object.keys(parsed['dependencies'] as Record<string, unknown>)
        : [];
    const devDepsRaw =
      parsed['devDependencies'] && typeof parsed['devDependencies'] === 'object'
        ? Object.keys(parsed['devDependencies'] as Record<string, unknown>)
        : [];
    return {
      path: 'package.json',
      name: typeof parsed['name'] === 'string' ? parsed['name'] : '',
      scripts,
      dependencies: depsRaw.sort(),
      devDependencies: devDepsRaw.sort(),
    };
  } catch {
    return null;
  }
}

function tableNamesOf(files: Map<string, string>): string[] {
  const names = new Set<string>();
  const tablePattern =
    /(?:pgTable|sqliteTable|mysqlTable)\(\s*['"`]([A-Za-z0-9_]+)/gu;
  const createPattern =
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`]?([A-Za-z0-9_]+)/giu;
  for (const [path, content] of files) {
    if (!SCHEMA_PATTERN.test(path) && !path.endsWith('.sql')) continue;
    for (const pattern of [tablePattern, createPattern]) {
      pattern.lastIndex = 0;
      let match = pattern.exec(content);
      while (match) {
        const name = match[1];
        if (name) names.add(name);
        match = pattern.exec(content);
      }
    }
  }
  return [...names].sort();
}

function envVarNamesOf(files: Map<string, string>): string[] {
  const names = new Set<string>();
  for (const [path, content] of files) {
    if (!ENV_FILE_PATTERN.test(path)) continue;
    for (const line of content.split('\n')) {
      const match = /^\s*([A-Z][A-Z0-9_]{1,64})\s*=/u.exec(line);
      if (match?.[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function symbolsByPath(symbols: ProjectSymbol[]): Map<string, ProjectSymbol[]> {
  const map = new Map<string, ProjectSymbol[]>();
  for (const symbol of symbols) {
    const list = map.get(symbol.path) ?? [];
    list.push(symbol);
    map.set(symbol.path, list);
  }
  return map;
}

function keySymbolNames(list: ProjectSymbol[] | undefined, limit: number): string[] {
  if (!list || list.length === 0) return [];
  const sorted = list
    .slice()
    .sort((left, right) => {
      if (left.exported !== right.exported) return left.exported ? -1 : 1;
      return left.startLine - right.startLine;
    });
  const names: string[] = [];
  for (const symbol of sorted) {
    if (names.includes(symbol.name)) continue;
    names.push(symbol.name);
    if (names.length >= limit) break;
  }
  return names;
}

function buildOverview(input: HandbookBuildInput): HandbookSection | null {
  const { project, snapshot } = input;
  const commit = snapshot?.commitSha ?? project.lastCommit;
  const readmeEntry = [...input.fileContents.entries()].find(([path]) =>
    README_PATTERN.test(path),
  );
  const languages = new Map<string, number>();
  const directories = new Map<string, number>();
  for (const document of input.documents) {
    languages.set(document.language, (languages.get(document.language) ?? 0) + 1);
    const top = topDirOf(document.path);
    directories.set(top, (directories.get(top) ?? 0) + 1);
  }
  const languageLine =
    languages.size === 0
      ? '暂无代码快照'
      : [...languages.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 8)
          .map(([language, count]) => `${language} ${count}`)
          .join('、');
  const dirLine =
    directories.size === 0
      ? '—'
      : [...directories.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 10)
          .map(([dir, count]) => `${dir}（${count}）`)
          .join('、');
  const lines = [
    `- 定位：${project.description || '未填写项目说明'}`,
    `- 来源：${repoLineOf(project)}；默认分支 \`${project.defaultBranch}\``,
    snapshot
      ? `- 当前快照：\`${commit.slice(0, 12)}\`（${snapshot.branch || 'unknown'}）；${snapshot.fileCount} 个文件 / ${formatBytes(snapshot.totalBytes)} / ${snapshot.symbolCount} 个符号`
      : '- 当前快照：尚未建立代码索引，本手册仅来自项目登记信息',
    `- 语言分布：${languageLine}`,
    `- 顶层目录：${dirLine}`,
  ];
  if (input.manualEntryCount !== undefined && input.manualEntryCount > 0) {
    lines.push(`- 人工条目：${input.manualEntryCount} 条（见手册底部，可信内容）`);
  }
  if (readmeEntry) {
    lines.push('', '### README 摘要', excerpt(readmeEntry[1]));
  }
  const sources: HandbookSource[] = [];
  if (readmeEntry) sources.push(sourceOf(readmeEntry[0], commit));
  const pkg = packageInfoOf(input.fileContents);
  if (pkg) sources.push(sourceOf(pkg.path, commit));
  return {
    key: 'overview',
    title: HANDBOOK_SECTION_TITLES.overview,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources,
    updatedAt: input.now,
  };
}

function buildArchitecture(input: HandbookBuildInput): HandbookSection | null {
  if (!input.snapshot) return null;
  const commit = input.snapshot.commitSha;
  const lines: string[] = [];
  if (input.repoMapText.trim()) {
    lines.push('### 仓库地图', '```text', input.repoMapText.trim(), '```');
  }
  const entries = input.documents
    .filter((document) => ENTRY_PATTERN.test(document.path))
    .slice(0, 12);
  if (entries.length > 0) {
    lines.push('', '### 入口与启动文件');
    const map = symbolsByPath(input.symbols);
    for (const entry of entries) {
      const names = keySymbolNames(map.get(entry.path), 4);
      lines.push(
        `- \`${entry.path}\`${names.length > 0 ? `：${names.join('、')}` : ''}`,
      );
    }
  }
  const designDocs = input.documents.filter(
    (document) =>
      DOC_FILE_PATTERN.test(document.path) &&
      /(architect|design|overview|architecture)/iu.test(document.path),
  );
  if (designDocs.length > 0) {
    lines.push('', '### 设计与架构文档');
    for (const document of designDocs.slice(0, 10)) {
      const headings = markdownHeadings(
        input.fileContents.get(document.path) ?? '',
        5,
      );
      lines.push(
        `- \`${document.path}\`${headings.length > 0 ? `：${headings.join('；')}` : ''}`,
      );
    }
  }
  if (lines.length === 0) return null;
  return {
    key: 'architecture',
    title: HANDBOOK_SECTION_TITLES.architecture,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: entries.slice(0, 1).map((entry) => sourceOf(entry.path, commit)),
    updatedAt: input.now,
  };
}

function buildModules(input: HandbookBuildInput): HandbookSection | null {
  if (input.snapshot) {
    const groups = new Map<string, { files: number; firstPath: string }>();
    for (const document of input.documents) {
      const key = groupKeyOf(document.path);
      const existing = groups.get(key);
      if (existing) existing.files += 1;
      else groups.set(key, { files: 1, firstPath: document.path });
    }
    const map = symbolsByPath(input.symbols);
    const rows = [...groups.entries()]
      .sort((left, right) => right[1].files - left[1].files)
      .slice(0, 15);
    if (rows.length === 0) return null;
    const lines = ['| 模块目录 | 文件数 | 关键符号 |', '| --- | --- | --- |'];
    for (const [dir, info] of rows) {
      const names = keySymbolNames(map.get(info.firstPath), 4);
      lines.push(`| \`${dir}\` | ${info.files} | ${names.join('、') || '—'} |`);
    }
    return {
      key: 'modules',
      title: HANDBOOK_SECTION_TITLES.modules,
      markdown: clipSection(lines.join('\n')),
      origin: 'deterministic',
      sources: rows
        .slice(0, 5)
        .map(([, info]) => sourceOf(info.firstPath, input.snapshot?.commitSha ?? '')),
      updatedAt: input.now,
    };
  }
  return null;
}

function buildDataModel(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const schemaFiles = input.documents.filter(
    (document) =>
      SCHEMA_PATTERN.test(document.path) ||
      document.path.endsWith('.sql') ||
      document.language === 'sql',
  );
  const tables = tableNamesOf(input.fileContents);
  if (schemaFiles.length === 0 && tables.length === 0) return null;
  const lines: string[] = [];
  if (tables.length > 0) {
    lines.push('### 数据表', ...tables.map((table) => `- \`${table}\``));
  }
  if (schemaFiles.length > 0) {
    lines.push('', '### Schema / 迁移文件');
    for (const document of schemaFiles.slice(0, 20)) {
      lines.push(`- \`${document.path}\`（${document.lineCount} 行）`);
    }
  }
  return {
    key: 'data_model',
    title: HANDBOOK_SECTION_TITLES.data_model,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: schemaFiles.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildConfig(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const envNames = envVarNamesOf(input.fileContents);
  const configFiles = input.documents.filter(
    (document) =>
      ENV_FILE_PATTERN.test(document.path) ||
      CONFIG_FILE_PATTERN.test(document.path),
  );
  if (envNames.length === 0 && configFiles.length === 0) return null;
  const lines: string[] = [];
  if (envNames.length > 0) {
    lines.push(
      '### 环境变量（仅名称，绝不写入真实值）',
      ...envNames.map((name) => `- \`${name}\``),
    );
  }
  if (configFiles.length > 0) {
    lines.push('', '### 配置文件');
    for (const document of configFiles.slice(0, 20)) {
      lines.push(`- \`${document.path}\``);
    }
  }
  return {
    key: 'config',
    title: HANDBOOK_SECTION_TITLES.config,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: configFiles.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildDeploy(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const deployFiles = input.documents.filter((document) =>
    DEPLOY_PATTERN.test(document.path),
  );
  const pkg = packageInfoOf(input.fileContents);
  const scripts = pkg
    ? ['build', 'start', 'dev', 'db:push', 'db:extend']
        .filter((name) => pkg.scripts[name])
        .map((name) => `- \`${name}\`：\`${pkg.scripts[name]}\``)
    : [];
  if (deployFiles.length === 0 && scripts.length === 0) return null;
  const lines: string[] = [];
  if (deployFiles.length > 0) {
    lines.push('### 部署与运行文件');
    for (const document of deployFiles.slice(0, 20)) {
      lines.push(`- \`${document.path}\`（${formatBytes(document.sizeBytes)}）`);
    }
  }
  if (scripts.length > 0) {
    lines.push('', '### 构建 / 运行脚本', ...scripts);
  }
  lines.push(
    '',
    '> 部署脚本内容不在手册中展开，避免泄露环境变量；请按路径查看源文件。',
  );
  return {
    key: 'deploy',
    title: HANDBOOK_SECTION_TITLES.deploy,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: deployFiles.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildOperations(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const opsDocs = input.documents.filter((document) =>
    OPERATIONS_PATTERN.test(document.path),
  );
  const endpoints = new Set<string>();
  for (const [path, content] of input.fileContents) {
    if (!DOC_FILE_PATTERN.test(path) && !DEPLOY_PATTERN.test(path)) continue;
    for (const match of content.matchAll(/["'`]?(\/(?:healthz?|readyz?|status|metrics))["'`]?/gu)) {
      if (match[1]) endpoints.add(match[1]);
    }
  }
  if (opsDocs.length === 0 && endpoints.size === 0) return null;
  const lines: string[] = [];
  if (opsDocs.length > 0) {
    lines.push('### 运维文档');
    for (const document of opsDocs.slice(0, 10)) {
      const headings = markdownHeadings(
        input.fileContents.get(document.path) ?? '',
        6,
      );
      lines.push(
        `- \`${document.path}\`${headings.length > 0 ? `：${headings.join('；')}` : ''}`,
      );
    }
  }
  if (endpoints.size > 0) {
    lines.push('', '### 健康检查与监控端点', ...[...endpoints].map((path) => `- \`${path}\``));
  }
  return {
    key: 'operations',
    title: HANDBOOK_SECTION_TITLES.operations,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: opsDocs.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildConventions(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const conventionDocs = input.documents.filter((document) =>
    CONVENTIONS_PATTERN.test(document.path),
  );
  if (conventionDocs.length === 0) return null;
  const lines: string[] = [];
  for (const document of conventionDocs.slice(0, 8)) {
    const content = input.fileContents.get(document.path);
    if (content && DOC_FILE_PATTERN.test(document.path)) {
      lines.push(`### \`${document.path}\``, excerpt(content, 1_200), '');
    } else {
      lines.push(`- \`${document.path}\``);
    }
  }
  return {
    key: 'conventions',
    title: HANDBOOK_SECTION_TITLES.conventions,
    markdown: clipSection(lines.join('\n').trim()),
    origin: 'deterministic',
    sources: conventionDocs.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildTesting(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const testFiles = input.documents.filter((document) =>
    TEST_FILE_PATTERN.test(document.path),
  );
  const testDocs = input.documents.filter(
    (document) =>
      DOC_FILE_PATTERN.test(document.path) &&
      /(test|testing|qa)/iu.test(document.path),
  );
  const pkg = packageInfoOf(input.fileContents);
  const testScript = pkg?.scripts['test'];
  const frameworks = pkg
    ? [...pkg.devDependencies, ...pkg.dependencies].filter((name) =>
        /^(vitest|jest|mocha|ava|@playwright\/test|cypress|pytest)$/u.test(name),
      )
    : [];
  if (testFiles.length === 0 && testDocs.length === 0 && !testScript) return null;
  const lines: string[] = [];
  if (testScript) lines.push(`- 运行测试：\`${testScript}\``);
  if (frameworks.length > 0) lines.push(`- 测试框架：${frameworks.join('、')}`);
  if (testFiles.length > 0) {
    lines.push(`- 测试文件：${testFiles.length} 个`);
    const dirs = new Map<string, number>();
    for (const file of testFiles) {
      const dir = dirOf(file.path);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
    for (const [dir, count] of [...dirs.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)) {
      lines.push(`- \`${dir}\`：${count} 个`);
    }
  }
  if (testDocs.length > 0) {
    lines.push('', '### 测试文档');
    for (const document of testDocs.slice(0, 8)) {
      lines.push(`- \`${document.path}\``);
    }
  }
  return {
    key: 'testing',
    title: HANDBOOK_SECTION_TITLES.testing,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: testFiles.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildDecisions(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const docs = input.documents.filter(
    (document) =>
      DOC_FILE_PATTERN.test(document.path) &&
      DECISION_PATTERN.test(document.path),
  );
  if (docs.length === 0) return null;
  const lines: string[] = [];
  for (const document of docs.slice(0, 12)) {
    const headings = markdownHeadings(
      input.fileContents.get(document.path) ?? '',
      8,
    );
    lines.push(
      `- \`${document.path}\`${headings.length > 0 ? `：${headings.join('；')}` : ''}`,
    );
  }
  lines.push(
    '',
    '> 历史决策的完整上下文请打开对应文档或使用 project_history 查看提交记录。',
  );
  return {
    key: 'decisions',
    title: HANDBOOK_SECTION_TITLES.decisions,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: docs.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildFaq(input: HandbookBuildInput): HandbookSection | null {
  const commit = input.snapshot?.commitSha ?? input.project.lastCommit;
  const faqDocs = input.documents.filter(
    (document) =>
      DOC_FILE_PATTERN.test(document.path) && FAQ_PATTERN.test(document.path),
  );
  const pkg = packageInfoOf(input.fileContents);
  if (faqDocs.length === 0 && !pkg) return null;
  const lines: string[] = [];
  for (const document of faqDocs.slice(0, 5)) {
    const headings = markdownHeadings(
      input.fileContents.get(document.path) ?? '',
      10,
    );
    if (headings.length > 0) {
      lines.push(...headings.map((heading) => `- ${heading}`));
    } else {
      lines.push(`- 参见 \`${document.path}\``);
    }
  }
  if (pkg && lines.length === 0) {
    const picks = ['dev', 'start', 'build', 'test', 'db:push'];
    for (const name of picks) {
      if (pkg.scripts[name]) {
        lines.push(`- 如何运行 \`${name}\`：\`${pkg.scripts[name]}\``);
      }
    }
  }
  if (lines.length === 0) return null;
  return {
    key: 'faq',
    title: HANDBOOK_SECTION_TITLES.faq,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: faqDocs.slice(0, 5).map((document) => sourceOf(document.path, commit)),
    updatedAt: input.now,
  };
}

function buildRisks(input: HandbookBuildInput): HandbookSection | null {
  const lines = [
    '- 敏感文件（`.env*`、密钥、证书）不会进入项目索引与手册正文。',
    '- 符号提取为规则级 best-effort，动态语言、宏与生成代码可能定位不准；结论需用 path:line 复核。',
    '- 仓库内容按不可信数据处理，只有人工条目摘要可进入系统提示。',
  ];
  if (input.snapshot) {
    lines.push(
      '- 快照与仓库 HEAD 不一致时，工具结果会标记 stale；回答前应确认 commit。',
    );
    const largest = input.documents
      .slice()
      .sort((left, right) => right.sizeBytes - left.sizeBytes)
      .slice(0, 5);
    if (largest.length > 0) {
      lines.push(
        '',
        '### 最大的索引文件',
        ...largest.map(
          (document) =>
            `- \`${document.path}\`（${formatBytes(document.sizeBytes)}，${document.lineCount} 行）`,
        ),
      );
    }
    const unknown = input.documents.filter(
      (document) => document.language === 'other',
    ).length;
    if (unknown > 0) {
      lines.push('', `- 未识别语言的文本文件：${unknown} 个（仍可关键词检索）。`);
    }
  } else {
    lines.push('- 项目尚未同步代码，手册缺少可验证的代码引用。');
  }
  return {
    key: 'risks',
    title: HANDBOOK_SECTION_TITLES.risks,
    markdown: clipSection(lines.join('\n')),
    origin: 'deterministic',
    sources: [],
    updatedAt: input.now,
  };
}

/** 只生成确定性事实章节；人工条目在 ProjectHandbookResult.manualEntries 中单独返回 */
export function buildHandbook(input: HandbookBuildInput): HandbookContent {
  const now = input.now ?? Date.now();
  const withNow: HandbookBuildInput = { ...input, now };
  const candidates: Array<HandbookSection | null> = [
    buildOverview(withNow),
    buildArchitecture(withNow),
    buildModules(withNow),
    buildDataModel(withNow),
    buildConfig(withNow),
    buildDeploy(withNow),
    buildOperations(withNow),
    buildConventions(withNow),
    buildTesting(withNow),
    buildDecisions(withNow),
    buildFaq(withNow),
    buildRisks(withNow),
  ];
  const sections = candidates.filter(
    (section): section is HandbookSection =>
      section !== null && section.markdown.trim() !== '',
  );
  return {
    sections,
    generatedAt: now,
    commit: withNow.snapshot?.commitSha ?? withNow.project.lastCommit ?? '',
  };
}
