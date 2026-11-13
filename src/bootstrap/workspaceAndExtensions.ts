import { resolve } from 'node:path';
import type { DynamicConfigCenter } from '../config/DynamicConfigCenter.js';
import type { Database } from '../db/client.js';
import { createGithubAdminPort } from '../github/GithubAdminPort.js';
import { GithubClient } from '../github/GithubClient.js';
import { OpenAIEmbeddingClient } from '../memory/EmbeddingClient.js';
import { PluginService } from '../plugins/PluginService.js';
import { DrizzlePluginStore } from '../plugins/PluginStore.js';
import { seedProjectsFromRoot } from '../projects/ProjectSeed.js';
import {
  ProjectService,
  type ProjectGithubHistoryPort,
} from '../projects/ProjectService.js';
import { DrizzleProjectStore } from '../projects/ProjectStore.js';
import { RepoSource } from '../projects/RepoSource.js';
import { LocalSkillManager } from '../skills/LocalSkillManager.js';
import type { SkillScanRoot } from '../skills/SkillRegistry.js';
import { SkillService } from '../skills/SkillService.js';
import { DrizzleSkillStore } from '../skills/SkillStore.js';
import type { HarnessLogger } from '../harness/AgentHarness.js';
import type { EnterpriseMcpServerConfig } from '../types/mcp-and-sandbox.js';
import type {
  GithubAdminPort,
  PluginAdminPort,
  ProjectAdminPort,
  ProjectMemberContextInput,
  SkillAdminPort,
  SkillFileAdminPort,
} from '../types/skills-plugins-projects.js';
import {
  envEnabled,
  envSeconds,
  errorText,
  readAgentVersion,
} from './envHelpers.js';

export interface WorkspaceAndExtensionsDeps {
  db: Database;
  configCenter: DynamicConfigCenter;
  clusterEnabled: boolean;
  harnessLogger: HarnessLogger;
  applyMergedMcpServers: (manual?: EnterpriseMcpServerConfig[]) => Promise<unknown>;
}

export interface WorkspaceAndExtensionsContext {
  stateRoot: string;
  embeddingClient?: OpenAIEmbeddingClient;
  plugins: PluginService;
  skills: SkillService;
  projects: ProjectService;
  githubClient?: GithubClient;
  defaultGithubRepo: () => Promise<string>;
  mergeMcpServers: (
    manual?: EnterpriseMcpServerConfig[],
  ) => Promise<EnterpriseMcpServerConfig[]>;
  githubAdminPort: GithubAdminPort;
  skillAdminPort: SkillAdminPort;
  skillFilePort: SkillFileAdminPort;
  pluginAdminPort: PluginAdminPort;
  projectAdminPort: ProjectAdminPort;
  startProjectSync: () => void;
  stopProjectSync: () => void;
  isProjectSyncRunning: () => boolean;
  stopSkillWatch: () => void;
}

/** 初始化 Embedding、插件、技能与项目知识库扩展模块 */
export async function setupWorkspaceAndExtensions(
  deps: WorkspaceAndExtensionsDeps,
): Promise<WorkspaceAndExtensionsContext> {
  const { db, configCenter, clusterEnabled, harnessLogger: logger } = deps;
  const extensionsConfig = configCenter.getExtensionsConfig();
  const stateRoot = resolve(
    process.cwd(),
    process.env.AGENT_STATE_DIR?.trim() || '.state',
  );
  const builtinSkillsDir = resolve(
    process.cwd(),
    process.env.SKILLS_BUILTIN_DIR?.trim() || 'skills/builtin',
  );
  const localSkillsDir = resolve(
    process.cwd(),
    process.env.SKILLS_LOCAL_DIR?.trim() || 'skills/local',
  );
  const marketSkillsDir = resolve(
    process.cwd(),
    process.env.SKILLS_MARKET_DIR?.trim() || 'skills/market',
  );

  const embeddingConfig = configCenter.getEmbeddingConfig();
  const embeddingDimensionsMismatch =
    Boolean(embeddingConfig?.enabled && embeddingConfig.apiKey) &&
    (embeddingConfig?.dimensions ?? 1536) !== 1536;
  if (embeddingDimensionsMismatch) {
    logger.error(
      {
        dimensions: embeddingConfig?.dimensions,
        required: 1536,
      },
      'EMBEDDING_DIMENSIONS 与数据库 vector(1536) 不一致，已禁用 embedding；请改回 1536 或同步调整表结构',
    );
  }
  const embeddingClient =
    embeddingConfig?.enabled &&
    embeddingConfig.apiKey &&
    !embeddingDimensionsMismatch
      ? new OpenAIEmbeddingClient({
          baseUrl: embeddingConfig.baseUrl,
          apiKey: embeddingConfig.apiKey,
          model: embeddingConfig.model,
          dimensions: embeddingConfig.dimensions,
        })
      : undefined;
  if (embeddingClient) {
    logger.info(
      { model: embeddingConfig?.model, dimensions: embeddingClient.dimensions },
      'embedding client enabled for semantic memory and project search',
    );
  }

  let skillServiceRef: SkillService | undefined;
  let pluginServiceRef: PluginService | undefined;
  let skillWatchStop: (() => void) | undefined;
  let projectSyncTimer: ReturnType<typeof setInterval> | undefined;

  const mergeMcpServers = async (
    manual: EnterpriseMcpServerConfig[] = configCenter.getMcpServers(),
  ): Promise<EnterpriseMcpServerConfig[]> => {
    if (!pluginServiceRef || !configCenter.getExtensionsConfig().pluginsEnabled) {
      return manual;
    }
    try {
      return [...manual, ...(await pluginServiceRef.getEnabledMcpServers())];
    } catch (error) {
      logger.warn({ error: errorText(error) }, 'failed to load plugin MCP servers');
      return manual;
    }
  };

  const plugins = new PluginService({
    store: new DrizzlePluginStore(db),
    pluginsRoot: resolve(stateRoot, 'plugins'),
    agentVersion: readAgentVersion(),
    env: process.env,
    ...(process.env.PLUGIN_ALLOWED_COMMANDS?.trim()
      ? {
          allowedCommands: process.env.PLUGIN_ALLOWED_COMMANDS.split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        }
      : {}),
    reservedSkillNames: () =>
      (skillServiceRef?.getAll() ?? [])
        .filter((skill) => skill.source !== 'plugin')
        .map((skill) => skill.name),
    manualMcpServerIds: () =>
      configCenter.getMcpServers().map((server) => server.id),
    onChanged: async () => {
      await skillServiceRef?.reload();
      await deps.applyMergedMcpServers();
    },
    allowMissingSecrets: envEnabled(process.env.PLUGIN_ALLOW_MISSING_SECRETS, false),
    logger,
  });
  pluginServiceRef = plugins;

  const skills = new SkillService({
    roots: async () => {
      const roots: SkillScanRoot[] = [
        { source: 'builtin', dir: builtinSkillsDir, modules: true },
        { source: 'market', dir: marketSkillsDir, modules: true },
        { source: 'local', dir: localSkillsDir },
      ];
      if (configCenter.getExtensionsConfig().pluginsEnabled) {
        try {
          roots.push(...(await plugins.getSkillRoots()));
        } catch (error) {
          logger.warn(
            { error: errorText(error) },
            'failed to load plugin skill roots',
          );
        }
      }
      return roots;
    },
    store: new DrizzleSkillStore(db),
    catalogLimit: extensionsConfig.skillCatalogLimit,
    catalogMaxChars: extensionsConfig.skillCatalogMaxChars,
    logger,
  });
  skillServiceRef = skills;

  try {
    await skills.init();
    skillWatchStop = skills.startWatching(() => {
      void skills
        .reload()
        .then((result) =>
          logger.info(
            { loaded: result.loaded, errors: result.errors.length },
            'skills reloaded after directory change',
          ),
        )
        .catch((error) =>
          logger.warn(
            { error: errorText(error) },
            'skill reload after directory change failed',
          ),
        );
    });
    const loaded = skills.getAll();
    const failed = loaded.filter((skill) => skill.loadError);
    logger.info(
      {
        loaded: loaded.length - failed.length,
        errors: failed.length,
        sample: failed
          .slice(0, 5)
          .map((skill) => `${skill.id}: ${skill.loadError}`),
        roots: [builtinSkillsDir, marketSkillsDir, localSkillsDir],
      },
      'skill registry ready',
    );
  } catch (error) {
    logger.error(
      { error: errorText(error) },
      'skill registry init failed, continuing without skills',
    );
  }

  const projectAllowedRoots = (process.env.PROJECT_ALLOWED_ROOTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(process.cwd(), item));
  const githubEnabled = envEnabled(process.env.GITHUB_ENABLED, false);
  const githubApiBase =
    process.env.GITHUB_API_BASE?.trim() || 'https://api.github.com';
  const githubAllowedHosts = (process.env.GITHUB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const githubCacheTtlSeconds = envSeconds(
    process.env.GITHUB_CACHE_TTL_SECONDS,
    300,
  );
  let githubClient: GithubClient | undefined;
  let githubInitError = '';
  if (githubEnabled) {
    try {
      githubClient = new GithubClient({
        token: process.env.GITHUB_TOKEN?.trim() ?? '',
        apiBase: githubApiBase,
        allowedHosts: githubAllowedHosts,
        cacheTtlMs: githubCacheTtlSeconds * 1000,
        logger,
      });
    } catch (error) {
      githubInitError = error instanceof Error ? error.message : String(error);
      logger.warn(
        { error: githubInitError },
        'github client init failed; github tools disabled',
      );
    }
  }
  const projectGithubPort: ProjectGithubHistoryPort | undefined = githubClient
    ? {
        search: async (repoRef, query, options) => {
          const result = await githubClient.search(repoRef, query, {
            kind: options.kind,
            ...(options.limit ? { limit: options.limit } : {}),
          });
          if ('kind' in result) {
            return { items: result.items, total: result.total };
          }
          return { items: [], total: 0 };
        },
      }
    : undefined;

  const projects = new ProjectService({
    store: new DrizzleProjectStore(db, logger),
    repoSource: new RepoSource({
      allowedRoots:
        projectAllowedRoots.length > 0 ? projectAllowedRoots : [process.cwd()],
      stateDir: resolve(stateRoot, 'projects'),
      logger,
    }),
    ...(embeddingClient ? { embedder: embeddingClient } : {}),
    ...(projectGithubPort ? { github: projectGithubPort } : {}),
    defaultProjectId: () => configCenter.getExtensionsConfig().defaultProjectId,
    logger,
    briefMaxChars: extensionsConfig.projectBriefMaxChars,
  });

  const defaultGithubRepo = async (): Promise<string> => {
    const defaultId = configCenter.getExtensionsConfig().defaultProjectId;
    if (!defaultId) return '';
    const record = await projects.getProject(defaultId);
    return record?.source.type === 'github' ? record.source.repo : '';
  };

  const projectSeedRoot = resolve(
    process.cwd(),
    process.env.PROJECT_SEED_DIR?.trim() || 'projects',
  );
  if (extensionsConfig.projectsEnabled) {
    try {
      await seedProjectsFromRoot({
        service: projects,
        root: projectSeedRoot,
        logger,
      });
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          root: projectSeedRoot,
        },
        'project seed import failed',
      );
    }
  }

  logger.info(
    {
      skillsEnabled: extensionsConfig.skillsEnabled,
      pluginsEnabled: extensionsConfig.pluginsEnabled,
      pluginsRoot: resolve(stateRoot, 'plugins'),
      projectsEnabled: extensionsConfig.projectsEnabled,
      projectSeedRoot,
      projectAllowedRoots:
        projectAllowedRoots.length > 0 ? projectAllowedRoots : [process.cwd()],
      defaultProjectId: extensionsConfig.defaultProjectId,
      githubEnabled,
      githubReady: Boolean(githubClient),
      githubTokenConfigured: githubClient?.hasToken ?? false,
      ...(githubInitError ? { githubInitError } : {}),
    },
    'extension services configured',
  );

  const githubAdminPort = createGithubAdminPort({
    enabled: githubEnabled,
    ...(githubClient ? { client: githubClient } : {}),
    ...(githubInitError ? { initError: githubInitError } : {}),
    toolsEnabled: () => configCenter.getExtensionsConfig().projectsEnabled,
    defaultRepo: defaultGithubRepo,
    apiBase: githubApiBase,
    allowedHosts: githubAllowedHosts,
    cacheTtlSeconds: githubCacheTtlSeconds,
  });

  const adminProjectMember: ProjectMemberContextInput = {
    senderStaffId: 'admin-console',
    isAdmin: true,
    conversationType: '1',
  };
  const skillAdminPort: SkillAdminPort = {
    list: () => skills.listAdmin(),
    listModules: () => skills.listModules(),
    reload: () => skills.reload(),
    setEnabled: (id, enabled) => skills.setEnabled(id, enabled),
    preview: async (input) => skills.preview(input),
    readResource: (input) => skills.readResource({ ...input, isAdmin: true }),
    usage: async (days) => Object.fromEntries(await skills.usageSince(days)),
  };
  const skillFilePort: SkillFileAdminPort = new LocalSkillManager({
    root: localSkillsDir,
    service: skills,
    logger,
  });
  const pluginAdminPort: PluginAdminPort = {
    list: () => plugins.list(),
    get: (id) => plugins.get(id),
    versions: (id) => plugins.versions(id),
    validatePackage: (input) => plugins.validatePackage(input),
    install: (input) => plugins.install(input),
    installFromZip: (input) => plugins.installFromZip(input),
    enable: (id) => plugins.enable(id),
    disable: (id) => plugins.disable(id),
    upgrade: (input) => plugins.upgrade(input),
    rollback: (id, version) => plugins.rollback(id, version),
    uninstall: (id, options) => plugins.uninstall(id, options),
  };
  const projectAdminPort: ProjectAdminPort = {
    list: (includeUnavailable) =>
      projects.listProjects(adminProjectMember, includeUnavailable !== false),
    get: (id) => projects.getProject(id),
    create: (input) => projects.createProject(input),
    update: (id, patch) => projects.updateProject(id, patch),
    remove: (id) => projects.deleteProject(id),
    queueSync: (id, trigger) => projects.queueSync(id, trigger),
    listSyncJobs: (id, limit) => projects.listSyncJobs(id, limit),
    listSnapshots: (id, limit) => projects.listSnapshots(id, limit),
    search: (id, query, limit) =>
      projects.searchProject({
        projectRef: id,
        query,
        ...(limit !== undefined ? { limit } : {}),
        member: adminProjectMember,
      }),
    status: (id) => projects.getProjectStatus(id),
    handbook: (id) =>
      projects.getHandbook({ projectRef: id, member: adminProjectMember }),
    handbookDraft: (id) => projects.getHandbookDraft(id),
    manualEntries: (id) => projects.listManualEntries(id),
    handbookVersions: (id, limit) => projects.listHandbookVersions(id, limit),
    generateHandbook: (id) => projects.generateHandbook(id),
    saveHandbookDraft: (id, input) =>
      projects.saveHandbookDraft(id, input, adminProjectMember.senderStaffId),
    publishHandbook: (id, version) => projects.publishHandbook(id, version),
    createManualEntry: (id, input) =>
      projects.createManualEntry(id, input, adminProjectMember.senderStaffId),
    updateManualEntry: (id, entryId, patch) =>
      projects.updateManualEntry(
        id,
        entryId,
        patch,
        adminProjectMember.senderStaffId,
      ),
    deleteManualEntry: (id, entryId) => projects.deleteManualEntry(id, entryId),
  };

  const projectSyncIntervalSeconds = Math.max(
    60,
    envSeconds(process.env.PROJECT_SYNC_INTERVAL_SECONDS, 900),
  );
  const startProjectSync = (): void => {
    if (projectSyncTimer) return;
    projectSyncTimer = setInterval(() => {
      void projects
        .syncDueProjects('schedule')
        .then((results) => {
          if (results.length === 0) return;
          const failed = results.filter((item) => !item.ok);
          if (failed.length > 0) {
            logger.warn(
              { total: results.length, failed: failed.slice(0, 5) },
              'project auto sync completed with failures',
            );
            return;
          }
          logger.info(
            { synced: results.length },
            'project auto sync completed',
          );
        })
        .catch((error) =>
          logger.warn({ error: errorText(error) }, 'project auto sync failed'),
        );
    }, projectSyncIntervalSeconds * 1_000);
    projectSyncTimer.unref?.();
  };
  const stopProjectSync = (): void => {
    if (!projectSyncTimer) return;
    clearInterval(projectSyncTimer);
    projectSyncTimer = undefined;
  };
  if (!clusterEnabled) startProjectSync();

  return {
    stateRoot,
    ...(embeddingClient ? { embeddingClient } : {}),
    plugins,
    skills,
    projects,
    ...(githubClient ? { githubClient } : {}),
    defaultGithubRepo,
    mergeMcpServers,
    githubAdminPort,
    skillAdminPort,
    skillFilePort,
    pluginAdminPort,
    projectAdminPort,
    startProjectSync,
    stopProjectSync,
    isProjectSyncRunning: () => Boolean(projectSyncTimer),
    stopSkillWatch: () => skillWatchStop?.(),
  };
}
