import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HandbookSectionKey,
  ProjectCreateInput,
  ProjectManualEntryInput,
} from '../types/skills-plugins-projects.js';
import {
  isProjectSensitivity,
  isProjectVisibility,
} from '../types/skills-plugins-projects.js';
import type { ProjectService } from './ProjectService.js';

const SEED_AUTHOR = 'seed:projects/manual';
const SECTION_BY_FILE: Record<string, HandbookSectionKey> = {
  overview: 'overview',
  architecture: 'architecture',
  modules: 'modules',
  'data-model': 'data_model',
  data_model: 'data_model',
  config: 'config',
  deploy: 'deploy',
  operations: 'operations',
  owners: 'operations',
  conventions: 'conventions',
  testing: 'testing',
  decisions: 'decisions',
  faq: 'faq',
  risks: 'risks',
};

export interface ProjectSeedLogger {
  info?(obj: Record<string, unknown>, message: string): void;
  warn?(obj: Record<string, unknown>, message: string): void;
}

export interface ProjectSeedResult {
  projectId: string;
  projectCreated: boolean;
  manualEntries: { created: number; updated: number; skipped: number };
}

export interface ProjectSeedOptions {
  service: ProjectService;
  /** 包含 <project>/project.json 与 manual/*.md 的根目录 */
  root: string;
  logger?: ProjectSeedLogger;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function parseSource(value: unknown): ProjectCreateInput['source'] {
  const record =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const type = asString(record['type']);
  if (type === 'local') {
    const branch = asString(record['branch']);
    return {
      type: 'local',
      path: asString(record['path']) || '.',
      ...(branch ? { branch } : {}),
    };
  }
  if (type === 'github') {
    const ref = asString(record['ref']);
    const depth = Number(record['depth']);
    return {
      type: 'github',
      repo: asString(record['repo']),
      ...(ref ? { ref } : {}),
      ...(Number.isFinite(depth) && depth > 0 ? { depth } : {}),
    };
  }
  return { type: 'manual' };
}

function toCreateInput(
  manifest: Record<string, unknown>,
  id: string,
  name: string,
): ProjectCreateInput {
  const visibility = asString(manifest['visibility']);
  const sensitivity = asString(manifest['sensitivity']);
  const autoSync = Number(manifest['autoSyncMinutes']);
  const defaultBranch = asString(manifest['defaultBranch']);
  return {
    id,
    name,
    aliases: asStringArray(manifest['aliases']),
    description: asString(manifest['description']),
    source: parseSource(manifest['source']),
    ...(defaultBranch ? { defaultBranch } : {}),
    ownerStaffIds: asStringArray(manifest['ownerStaffIds']),
    ...(isProjectVisibility(visibility) ? { visibility } : {}),
    ...(isProjectSensitivity(sensitivity) ? { sensitivity } : {}),
    isDefault:
      manifest['default'] === true || manifest['isDefault'] === true,
    enabled: manifest['enabled'] !== false,
    ...(Number.isFinite(autoSync) && autoSync > 0
      ? { autoSyncMinutes: Math.trunc(autoSync) }
      : {}),
  };
}

async function readManualEntries(
  directory: string,
): Promise<ProjectManualEntryInput[]> {
  const files = await readdir(directory).catch(() => [] as string[]);
  const entries: ProjectManualEntryInput[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue;
    const section = SECTION_BY_FILE[file.slice(0, -3).toLowerCase()];
    if (!section) continue;
    const markdown = await readFile(join(directory, file), 'utf8').catch(
      () => '',
    );
    if (!markdown.trim()) continue;
    const heading = markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    entries.push({
      section,
      title: heading || file,
      markdown,
      visibility: 'team',
      sensitivity: 'team',
      injectToBrief: section === 'overview',
      priority: section === 'overview' ? 10 : 0,
    });
  }
  return entries;
}

async function seedOne(
  projectDir: string,
  options: ProjectSeedOptions,
): Promise<ProjectSeedResult | null> {
  const manifestPath = join(projectDir, 'project.json');
  const raw = await readFile(manifestPath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    options.logger?.warn?.(
      { manifestPath },
      'project seed manifest is not JSON',
    );
    return null;
  }
  const id = asString(manifest['id']);
  const name = asString(manifest['name']);
  if (!id || !name) {
    options.logger?.warn?.(
      { manifestPath },
      'project seed manifest missing id or name',
    );
    return null;
  }
  let project = await options.service.getProject(id);
  let projectCreated = false;
  if (!project) {
    project = await options.service.createProject(toCreateInput(manifest, id, name));
    projectCreated = true;
  }
  const entries = await readManualEntries(join(projectDir, 'manual'));
  const manualEntries =
    entries.length > 0
      ? await options.service.importManualEntries(id, entries, SEED_AUTHOR)
      : { created: 0, updated: 0, skipped: 0 };
  return { projectId: id, projectCreated, manualEntries };
}

/** 扫描 seed 根目录下每个子项目；已存在的项目只更新仍由种子维护的条目 */
export async function seedProjectsFromRoot(
  options: ProjectSeedOptions,
): Promise<ProjectSeedResult[]> {
  const children = await readdir(options.root, { withFileTypes: true }).catch(
    () => [],
  );
  const results: ProjectSeedResult[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const result = await seedOne(join(options.root, child.name), options);
    if (!result) continue;
    results.push(result);
    options.logger?.info?.(
      {
        projectId: result.projectId,
        projectCreated: result.projectCreated,
        ...result.manualEntries,
      },
      'project seed imported',
    );
  }
  return results;
}
