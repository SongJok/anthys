import { randomUUID } from 'node:crypto';
import {
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  SkillDefinition,
  SkillDraftInput,
  SkillFileAdminPort,
  SkillResourceInfo,
  SkillResourceWriteInput,
  SkillValidationResult,
} from '../types/skills-plugins-projects.js';
import { parseSkillMarkdown, SkillValidationError } from './SkillRegistry.js';
import type { SkillService } from './SkillService.js';

const SKILL_FILE = 'SKILL.md';
const MAX_BODY_BYTES = 60 * 1024;
const MAX_RESOURCE_BYTES = 256 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export interface LocalSkillManagerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface LocalSkillManagerOptions {
  root: string;
  service: SkillService;
  logger?: LocalSkillManagerLogger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

function yamlBlock(key: string, value: string): string[] {
  const lines = normalizeText(value).split('\n');
  return [`${key}: |`, ...lines.map((line) => (line ? `  ${line}` : ''))];
}

function yamlList(key: string, values: string[]): string {
  return `${key}: [${values.map((value) => value.replace(/[,[\]{}]/gu, ' ')).join(', ')}]`;
}

export function serializeSkillMarkdown(input: SkillDraftInput): string {
  const name = input.name.trim();
  const version = (input.version ?? '1.0.0').trim() || '1.0.0';
  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const allowedTools = (input.allowedTools ?? [])
    .map((tool) => tool.trim())
    .filter(Boolean);
  const risk = input.risk ?? 'read';
  const visibility = input.visibility ?? 'public';
  const maxInstructionChars = Math.min(
    8_000,
    Math.max(1_000, Math.trunc(input.maxInstructionChars ?? 4_000)),
  );
  const lines = [
    '---',
    `name: ${name}`,
    ...yamlBlock('description', input.description.trim()),
    `version: ${version}`,
    ...yamlBlock('when_to_use', input.whenToUse.trim()),
    yamlList('tags', tags),
    yamlList('allowed_tools', allowedTools),
    `risk: ${risk}`,
    `visibility: ${visibility}`,
    `max_instruction_chars: ${maxInstructionChars}`,
    '---',
    '',
    normalizeText(input.body).trim(),
    '',
  ];
  return lines.join('\n');
}

export function validateSkillDraft(input: SkillDraftInput): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = input.name.trim();
  if (!NAME_PATTERN.test(name)) {
    errors.push(
      '技能 name 只能使用小写字母、数字和短横线，并以字母开头（2-64 位）',
    );
  }
  const version = (input.version ?? '1.0.0').trim() || '1.0.0';
  if (!VERSION_PATTERN.test(version)) {
    errors.push('version 必须是语义化版本，例如 1.0.0');
  }
  const body = normalizeText(input.body).trim();
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (!body) errors.push('技能正文不能为空');
  if (bodyBytes > MAX_BODY_BYTES) {
    errors.push(`技能正文不能超过 ${MAX_BODY_BYTES} 字节`);
  }
  if (!input.description.trim()) errors.push('description 不能为空');
  if (!input.whenToUse.trim()) errors.push('when_to_use 不能为空');
  let frontmatter: SkillValidationResult['frontmatter'];
  if (errors.length === 0) {
    try {
      const parsed = parseSkillMarkdown(serializeSkillMarkdown(input), name);
      frontmatter = parsed.frontmatter;
      const cap = parsed.frontmatter.max_instruction_chars ?? 4_000;
      if (parsed.body.length > cap) {
        warnings.push(
          `正文 ${parsed.body.length} 字符，超过单次注入上限 ${cap}，模型需要分段 skill_read`,
        );
      }
    } catch (error) {
      if (error instanceof SkillValidationError) errors.push(error.message);
      else errors.push(errorMessage(error));
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(frontmatter ? { frontmatter } : {}),
    bodyBytes,
  };
}

/**
 * 维护 skills/local 下的技能文件。
 * 只允许修改 local 来源；写入使用临时文件 + rename，避免扫描到半截内容。
 */
export class LocalSkillManager implements SkillFileAdminPort {
  private readonly root: string;
  private readonly service: SkillService;
  private readonly logger?: LocalSkillManagerLogger;

  constructor(options: LocalSkillManagerOptions) {
    this.root = path.resolve(options.root);
    this.service = options.service;
    this.logger = options.logger;
  }

  public validate(input: SkillDraftInput): SkillValidationResult {
    return validateSkillDraft(input);
  }

  public async create(input: SkillDraftInput): Promise<SkillDefinition> {
    const validation = this.requireValid(input);
    const name = validation.frontmatter!.name;
    await mkdir(this.root, { recursive: true, mode: 0o755 });
    const dir = path.join(this.root, name);
    if (await this.exists(dir)) {
      throw new SkillValidationError(`本地技能已存在：${name}`);
    }
    await this.writeSkill(dir, input);
    return this.reloadAndGet(`local:${name}`);
  }

  public async update(id: string, input: SkillDraftInput): Promise<SkillDefinition> {
    const current = this.requireLocal(id);
    const targetName = (input.name || current.name).trim();
    if (targetName !== current.name) {
      throw new SkillValidationError(
        '技能 name 是目录标识，不支持重命名；请新建后再删除旧技能',
      );
    }
    const validation = this.requireValid({ ...input, name: current.name });
    await this.writeSkill(
      current.dir,
      { ...input, name: validation.frontmatter!.name },
    );
    return this.reloadAndGet(current.id);
  }

  public async remove(id: string): Promise<void> {
    const current = this.requireLocal(id);
    const real = await realpath(current.dir);
    if (!isInside(this.root, real)) {
      throw new SkillValidationError('拒绝删除技能目录之外的路径');
    }
    await rm(real, { recursive: true, force: true });
    await this.reload();
  }

  public async writeResource(
    id: string,
    input: SkillResourceWriteInput,
  ): Promise<SkillResourceInfo> {
    const current = this.requireLocal(id);
    const relative = this.normalizeResourcePath(input.path);
    if (relative === SKILL_FILE) {
      throw new SkillValidationError('请通过技能编辑器修改 SKILL.md');
    }
    const content = normalizeText(input.content);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_RESOURCE_BYTES) {
      throw new SkillValidationError(
        `资源文件不能超过 ${MAX_RESOURCE_BYTES} 字节`,
      );
    }
    if (content.includes('\u0000')) {
      throw new SkillValidationError('资源文件必须是文本');
    }
    const target = path.resolve(current.dir, relative);
    if (!isInside(current.dir, target)) {
      throw new SkillValidationError('资源路径逃逸技能目录');
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await this.atomicWrite(target, content);
    await this.reload();
    return { path: relative, sizeBytes: bytes };
  }

  public async removeResource(id: string, resourcePath: string): Promise<void> {
    const current = this.requireLocal(id);
    const relative = this.normalizeResourcePath(resourcePath);
    if (relative === SKILL_FILE) {
      throw new SkillValidationError('不能删除 SKILL.md');
    }
    const target = path.resolve(current.dir, relative);
    if (!isInside(current.dir, target)) {
      throw new SkillValidationError('资源路径逃逸技能目录');
    }
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new SkillValidationError(`资源不存在：${relative}`);
    }
    if (!isInside(current.dir, real)) {
      throw new SkillValidationError('资源通过符号链接逃逸技能目录');
    }
    const info = await stat(real);
    if (!info.isFile()) throw new SkillValidationError('资源不是普通文件');
    await rm(real, { force: true });
    await this.reload();
  }

  private requireValid(input: SkillDraftInput): SkillValidationResult {
    const validation = validateSkillDraft(input);
    if (!validation.ok) {
      throw new SkillValidationError(validation.errors.join('；'));
    }
    return validation;
  }

  private requireLocal(id: string): SkillDefinition {
    const skill = this.service.getByNameOrId(id.trim());
    if (!skill) throw new SkillValidationError(`技能不存在：${id}`);
    if (skill.source !== 'local') {
      throw new SkillValidationError(
        `只有 local 技能可以编辑，当前来源为 ${skill.source}`,
      );
    }
    return skill;
  }

  private normalizeResourcePath(value: string): string {
    const relative = value.trim().replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (
      !relative ||
      relative.split('/').some((segment) => segment === '..' || segment === '')
    ) {
      throw new SkillValidationError(`非法资源路径：${value}`);
    }
    if (relative.length > 200) {
      throw new SkillValidationError('资源路径不能超过 200 字符');
    }
    return relative;
  }

  private async writeSkill(dir: string, input: SkillDraftInput): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await this.atomicWrite(
      path.join(dir, SKILL_FILE),
      serializeSkillMarkdown(input),
    );
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temp = `${target}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(temp, content, 'utf8');
    await rename(temp, target);
  }

  private async reload(): Promise<void> {
    try {
      await this.service.reload();
    } catch (error) {
      this.logger?.warn(
        { error: errorMessage(error) },
        'failed to reload skills after local edit',
      );
    }
  }

  private async reloadAndGet(id: string): Promise<SkillDefinition> {
    await this.reload();
    const skill = this.service.getByNameOrId(id);
    if (!skill) {
      throw new SkillValidationError(
        `技能写入后未能加载，请检查 ${SKILL_FILE} 内容`,
      );
    }
    return skill;
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }
}
