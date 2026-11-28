import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ExecutionContext,
  IToolProvider,
  ToolDefinition,
  ToolExecutionOutput,
} from '../../types/core.js';
import type {
  CompiledTestcaseDocument,
  TestcaseCompileSelection,
  TestcaseExecutionStatus,
  TestcaseWorkspace,
  TestcaseWorkspacePatch,
} from '../../types/testcase-workspace.js';
import {
  buildTestcaseXlsxSheets,
  toPlainTestcaseRows,
} from '../../testcase/TestcaseCompiler.js';
import { TestcaseRevisionConflictError } from '../../testcase/TestcaseWorkspaceStore.js';
import {
  TestcaseWorkspaceService,
  type TestcaseActor,
} from '../../testcase/TestcaseWorkspaceService.js';
import {
  generateWorkspaceArtifact,
  type ArtifactFormat,
} from '../artifacts/ArtifactGenerator.js';
import type { ArtifactSender } from '../artifacts/ArtifactToolProvider.js';

export interface TestcaseWorkspaceToolProviderOptions {
  service: TestcaseWorkspaceService;
  isAdmin: (staffId: string) => boolean;
  artifact?: {
    sender: ArtifactSender;
    allowedRoots: string[];
    maxBytes?: number;
  };
}

function stringListSchema(description?: string): Record<string, unknown> {
  return {
    type: 'array',
    items: { type: 'string' },
    ...(description ? { description } : {}),
  };
}

const REQUIREMENT_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'module', 'sourceRef'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    module: { type: 'string' },
    sourceRef: { type: 'string' },
    rules: stringListSchema(),
    constraints: stringListSchema(),
    status: { type: 'string', enum: ['active', 'superseded', 'unresolved'] },
  },
};

const EVIDENCE_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'type', 'sourceRef', 'summary'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: {
      type: 'string',
      enum: ['user', 'document', 'project', 'mcp', 'dws', 'ui', 'web'],
    },
    sourceRef: { type: 'string' },
    collectedAt: { type: 'number' },
    scope: { type: 'string' },
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    requirementIds: stringListSchema(),
    conflictsWith: stringListSchema(),
    datasetRef: { type: 'string' },
  },
};

const EXECUTION_SCHEMA = {
  type: 'object',
  description: '人工或外部测试平台回填的执行结果；机器人不执行用例',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['untested', 'passed', 'failed', 'blocked'],
    },
    executedAt: { type: 'number' },
    executor: { type: 'string' },
    note: { type: 'string', description: '失败现象或阻塞原因' },
  },
};

const CASE_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'module', 'title', 'steps', 'expectedResults'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    module: { type: 'string' },
    title: { type: 'string' },
    preconditions: stringListSchema(),
    steps: stringListSchema('原子操作步骤，不要手工加 1. 序号前缀'),
    expectedResults: stringListSchema('具体可观察预期结果，不要手工加 1. 序号前缀'),
    priority: { type: 'string', enum: ['高', '中', '低'] },
    testMethod: {
      type: 'string',
      description:
        '使用 需求分析法/等价类划分法/边界值分析法/场景法/错误猜测法 或其 + 组合（如 需求分析法+场景法）',
    },
    scenarioType: {
      type: 'string',
      enum: ['normal', 'exception', 'boundary', 'other'],
    },
    requirementIds: stringListSchema(),
    evidenceIds: stringListSchema(),
    assumptions: stringListSchema(),
    status: { type: 'string', enum: ['draft', 'ready', 'superseded'] },
    riskIds: stringListSchema('本用例验证的需求评审风险 ID'),
    defectIds: stringListSchema('本用例复现或回归验证的缺陷 ID'),
    execution: EXECUTION_SCHEMA,
  },
};

const RISK_ITEM_SCHEMA = {
  type: 'object',
  description: '需求评审识别出的风险点',
  required: ['id', 'module', 'title'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    module: { type: 'string' },
    title: { type: 'string' },
    detail: { type: 'string', description: '风险成因与影响' },
    severity: { type: 'string', enum: ['高', '中', '低'] },
    requirementIds: stringListSchema(),
    evidenceIds: stringListSchema(),
    mitigation: { type: 'string', description: '应对或规避方式' },
    status: { type: 'string', enum: ['open', 'mitigated', 'accepted'] },
  },
};

const DEFECT_ITEM_SCHEMA = {
  type: 'object',
  description: '缺陷记录，用于生成复现用例与回归验证',
  required: ['id', 'module', 'title', 'sourceRef'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    module: { type: 'string' },
    title: { type: 'string' },
    sourceRef: { type: 'string', description: '缺陷单号或来源链接' },
    severity: { type: 'string', enum: ['高', '中', '低'] },
    symptom: { type: 'string', description: '可复现的现象与触发条件' },
    status: { type: 'string', enum: ['open', 'fixed', 'verified', 'rejected'] },
  },
};

const DECISION_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'topic', 'value'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    topic: { type: 'string' },
    value: { type: 'string' },
    sourceMessageId: { type: 'string' },
    createdAt: { type: 'number' },
  },
};

const QUESTION_ITEM_SCHEMA = {
  type: 'object',
  required: ['id', 'question'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    question: { type: 'string' },
    blocking: { type: 'boolean' },
    requirementIds: stringListSchema(),
    status: { type: 'string', enum: ['open', 'resolved'] },
  },
};

function deltaCollectionSchema(itemSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      upsert: { type: 'array', items: itemSchema },
      removeIds: stringListSchema(),
    },
  };
}

const PATCH_SCHEMA = {
  type: 'object',
  description:
    '增量补丁。只提交本次变化，不要求填写所有字段；同一轮请合并为一次更新。upsert 使用稳定语义 id；removeIds 删除条目。',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    projectId: {
      type: 'string',
      description: '绑定项目 ID；传空字符串可解除绑定',
    },
    archived: {
      type: 'boolean',
      description: '标记工作区为已归档，避免后续新需求继续绑定旧工作区',
    },
    requirements: deltaCollectionSchema(REQUIREMENT_ITEM_SCHEMA),
    evidence: deltaCollectionSchema(EVIDENCE_ITEM_SCHEMA),
    cases: deltaCollectionSchema(CASE_ITEM_SCHEMA),
    decisions: deltaCollectionSchema(DECISION_ITEM_SCHEMA),
    openQuestions: deltaCollectionSchema(QUESTION_ITEM_SCHEMA),
    risks: deltaCollectionSchema(RISK_ITEM_SCHEMA),
    defects: deltaCollectionSchema(DEFECT_ITEM_SCHEMA),
    outputPreferences: {
      type: 'object',
      additionalProperties: false,
      properties: {
        screenshotMarkers: { type: 'boolean' },
        includeDataChecklist: { type: 'boolean' },
        includeTraceability: { type: 'boolean' },
        includeAutomationFeasibility: { type: 'boolean' },
      },
    },
  },
};

type WorkspaceToolDefinition = Omit<ToolDefinition, 'execute'> & {
  executeStructured: NonNullable<ToolDefinition['executeStructured']>;
};

function toTool(tool: WorkspaceToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: async (args, ctx) => (await tool.executeStructured(args, ctx)).text,
  };
}

export class TestcaseWorkspaceToolProvider implements IToolProvider {
  public readonly providerName = 'testcase-workspace';

  public constructor(private readonly options: TestcaseWorkspaceToolProviderOptions) {}

  public async getTools(ctx: ExecutionContext): Promise<ToolDefinition[]> {
    const roots = this.options.artifact
      ? await Promise.all(
          this.options.artifact.allowedRoots.map((root) =>
            realpath(root).catch(() => resolve(root)),
          ),
        )
      : [];
    return [
      this.listTool(ctx),
      this.getTool(ctx),
      this.selectTool(ctx),
      this.createTool(ctx),
      this.updateTool(ctx),
      this.compileTool(ctx, roots),
    ].map(toTool);
  }

  private listTool(ctx: ExecutionContext): WorkspaceToolDefinition {
    return {
      name: 'testcase_workspace_list',
      description:
        '列出当前用户在当前会话或跨会话可继续的测试用例工作区。支持关键词检索与归档过滤，只在需要恢复、查找或切换工作区时使用。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          allConversations: { type: 'boolean', default: false },
          query: { type: 'string', description: '按标题/项目关键词筛选' },
          includeArchived: { type: 'boolean', default: false },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      risk: 'read',
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        const allConversations = args.allConversations === true;
        const conversationId =
          typeof args.conversationId === 'string' && args.conversationId.trim()
            ? args.conversationId.trim()
            : allConversations
              ? undefined
              : ctx.conversationId;
        const items = await this.options.service.query(this.actor(ctx), {
          ...(conversationId ? { conversationId } : {}),
          ...(typeof args.query === 'string' && args.query.trim()
            ? { query: args.query.trim() }
            : {}),
          includeArchived: args.includeArchived === true,
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        });
        return jsonOutput(items, `找到 ${items.length} 个测试用例工作区`);
      },
    };
  }

  private getTool(ctx: ExecutionContext): WorkspaceToolDefinition {
    return {
      name: 'testcase_workspace_get',
      description:
        '读取工作区摘要、指定明细或历史合稿版本。默认只读摘要；支持按 module/status 筛选及过滤 superseded 条目。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          section: {
            type: 'string',
            enum: [
              'summary',
              'requirements',
              'cases',
              'evidence',
              'decisions',
              'questions',
              'risks',
              'defects',
              'versions',
              'full',
            ],
            default: 'summary',
          },
          module: { type: 'string', description: '可选：按模块名称过滤' },
          status: { type: 'string', description: '可选：按条目状态过滤' },
          includeSuperseded: { type: 'boolean', default: true },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        assertActiveWorkspace(ctx, args.workspaceId);
        const actor = this.actor(ctx);
        const workspaceId = String(args.workspaceId);
        const workspace = await this.options.service.get(actor, workspaceId);
        const section = String(args.section ?? 'summary');
        const offset = Math.max(0, Number(args.offset ?? 0));
        const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 200));
        const moduleFilter =
          typeof args.module === 'string' && args.module.trim()
            ? args.module.trim()
            : undefined;
        const statusFilter =
          typeof args.status === 'string' && args.status.trim()
            ? args.status.trim()
            : undefined;
        const includeSuperseded = args.includeSuperseded !== false;

        if (section === 'summary') {
          return {
            text: this.options.service.buildPromptSummary(workspace),
            summary: `读取工作区 ${workspace.id} 摘要`,
          };
        }
        if (section === 'versions') {
          const versions = await this.options.service.versions(actor, workspace.id, limit);
          const items = versions.map((item) => ({
            version: item.version,
            sourceRevision: item.sourceRevision,
            ...(item.label ? { label: item.label } : {}),
            createdAt: item.createdAt,
            statistics: item.document.statistics,
            issueCount: item.document.issues.length,
            issues: item.document.issues,
          }));
          return jsonOutput(
            {
              workspaceId: workspace.id,
              revision: workspace.revision,
              section,
              total: items.length,
              items,
            },
            `读取工作区 ${workspace.id} 的历史版本`,
          );
        }
        if (section === 'full') {
          return jsonOutput(workspace, `读取工作区 ${workspace.id} 完整内容`);
        }

        const rawSource: Array<Record<string, unknown>> =
          section === 'requirements'
            ? (workspace.state.requirements as unknown as Array<Record<string, unknown>>)
            : section === 'cases'
              ? (workspace.state.cases as unknown as Array<Record<string, unknown>>)
              : section === 'evidence'
                ? (workspace.state.evidence as unknown as Array<Record<string, unknown>>)
                : section === 'decisions'
                  ? (workspace.state.decisions as unknown as Array<Record<string, unknown>>)
                  : section === 'risks'
                    ? (workspace.state.risks as unknown as Array<Record<string, unknown>>)
                    : section === 'defects'
                      ? (workspace.state.defects as unknown as Array<Record<string, unknown>>)
                      : (workspace.state.openQuestions as unknown as Array<Record<string, unknown>>);

        const filtered = rawSource.filter((item) => {
          if (!includeSuperseded && item.status === 'superseded') return false;
          if (moduleFilter && item.module !== moduleFilter) return false;
          if (statusFilter && item.status !== statusFilter) return false;
          return true;
        });

        return jsonOutput(
          {
            workspaceId: workspace.id,
            revision: workspace.revision,
            section,
            total: filtered.length,
            items: filtered.slice(offset, offset + limit),
          },
          `读取工作区 ${workspace.id} 的 ${section}`,
        );
      },
    };
  }

  private selectTool(ctx: ExecutionContext): WorkspaceToolDefinition {
    return {
      name: 'testcase_workspace_select',
      description: '从当前用户可访问的工作区中显式选择本次运行继续处理的对象。后台任务不能切换已绑定的工作区。',
      parametersJsonSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        const workspaceId = String(args.workspaceId);
        const activeWorkspaceId = currentWorkspaceId(ctx);
        if (
          ctx.jobId &&
          activeWorkspaceId &&
          activeWorkspaceId !== workspaceId &&
          !ctx.testcaseWorkspaceBinding?.autoSnapshotted
        ) {
          throw new Error('后台任务不能切换已绑定的测试用例工作区');
        }
        const workspace = await this.options.service.get(this.actor(ctx), workspaceId);
        bindWorkspace(ctx, workspace.id, workspace.revision);
        return {
          text: this.options.service.buildPromptSummary(workspace),
          summary: `已选择工作区 ${workspace.id} r${workspace.revision}`,
        };
      },
    };
  }

  private createTool(ctx: ExecutionContext): WorkspaceToolDefinition {
    return {
      name: 'testcase_workspace_create',
      description: '创建一个新的测试用例工作区。是否创建、何时创建由模型根据用户意图决定。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          projectId: { type: 'string' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      risk: 'write',
      internalWrite: true,
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        if (
          ctx.jobId &&
          currentWorkspaceId(ctx) &&
          !ctx.testcaseWorkspaceBinding?.autoSnapshotted
        ) {
          throw new Error('后台任务不能创建或切换测试用例工作区');
        }
        const workspace = await this.options.service.create(this.actor(ctx), {
          title: String(args.title),
          ...(typeof args.projectId === 'string' && args.projectId.trim()
            ? { projectId: args.projectId.trim() }
            : {}),
        });
        bindWorkspace(ctx, workspace.id, workspace.revision);
        return jsonOutput(
          workspace,
          `已创建测试用例工作区 ${workspace.id}`,
        );
      },
    };
  }

  private updateTool(ctx: ExecutionContext): WorkspaceToolDefinition {
    return {
      name: 'testcase_workspace_update',
      description:
        '增量更新需求、证据、草稿、决策、评审风险、缺陷、执行结果或输出偏好。只传本次变化；同一轮请合并为单次调用；baseRevision 必须来自最近一次读取。内部草稿保存无外部副作用。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          baseRevision: { type: 'integer', minimum: 1 },
          patch: PATCH_SCHEMA,
        },
        required: ['workspaceId', 'baseRevision', 'patch'],
        additionalProperties: false,
      },
      risk: 'write',
      internalWrite: true,
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        assertActiveWorkspace(ctx, args.workspaceId);
        const actor = this.actor(ctx);
        const workspaceId = String(args.workspaceId);
        try {
          const workspace = await this.options.service.update(
            actor,
            workspaceId,
            Number(args.baseRevision),
            args.patch as TestcaseWorkspacePatch,
          );
          bindWorkspace(ctx, workspace.id, workspace.revision);
          return {
            text: this.options.service.buildPromptSummary(workspace),
            summary: `已更新工作区 ${workspace.id} 到 r${workspace.revision}`,
          };
        } catch (error) {
          if (error instanceof TestcaseRevisionConflictError) {
            await this.throwSyncedConflict(ctx, actor, workspaceId, error);
          }
          throw error;
        }
      },
    };
  }

  private compileTool(
    ctx: ExecutionContext,
    roots: string[],
  ): WorkspaceToolDefinition {
    return {
      name: 'testcase_compile',
      description:
        '对当前工作区执行确定性去重、排序、编号、统计、追溯检查并生成版本，同时输出风险覆盖、缺陷复现追溯、执行统计与回归范围建议。可用 selection 只合稿回归子集；可生成 md/json/csv/xlsx/docx 文件，deliver=true 时才投递到当前会话。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          baseRevision: { type: 'integer', minimum: 1 },
          label: { type: 'string' },
          selection: {
            type: 'object',
            description:
              '可选：只合稿命中条件的用例（回归子集或单模块导出）；填写的多个条件同时生效',
            additionalProperties: false,
            properties: {
              modules: stringListSchema(),
              requirementIds: stringListSchema(),
              caseIds: stringListSchema('草稿稳定 ID，不是最终用例编号'),
              priorities: {
                type: 'array',
                items: { type: 'string', enum: ['高', '中', '低'] },
              },
              executionStatuses: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['untested', 'passed', 'failed', 'blocked'],
                },
              },
            },
          },
          format: {
            type: 'string',
            enum: ['md', 'json', 'csv', 'xlsx', 'docx'],
            default: 'md',
          },
          fileName: { type: 'string' },
          deliver: { type: 'boolean', default: false },
        },
        required: ['workspaceId', 'baseRevision'],
        additionalProperties: false,
      },
      risk: 'write',
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        assertActiveWorkspace(ctx, args.workspaceId);
        const actor = this.actor(ctx);
        const workspaceId = String(args.workspaceId);
        let workspace: TestcaseWorkspace;
        let document: CompiledTestcaseDocument;
        try {
          workspace = await this.options.service.get(actor, workspaceId);
          const selection = parseSelection(args.selection);
          document = await this.options.service.compile(actor, {
            workspaceId,
            baseRevision: Number(args.baseRevision),
            ...(typeof args.label === 'string' ? { label: args.label } : {}),
            ...(selection ? { selection } : {}),
          });
        } catch (error) {
          if (error instanceof TestcaseRevisionConflictError) {
            await this.throwSyncedConflict(ctx, actor, workspaceId, error);
          }
          throw error;
        }
        const format = String(args.format ?? 'md') as ArtifactFormat;
        if (!['md', 'json', 'csv', 'xlsx', 'docx'].includes(format)) {
          throw new Error(`不支持的格式：${format}`);
        }
        const artifact = this.options.artifact;
        if (!artifact && ['xlsx', 'docx'].includes(format)) {
          return jsonOutput(document, `已编译 v${document.version}，当前未配置文件输出通道`);
        }
        if (!artifact) {
          return {
            text:
              format === 'json'
                ? JSON.stringify(document)
                : format === 'csv'
                  ? toCsv(document)
                  : document.markdown,
            summary: `已编译工作区 ${document.workspaceId} v${document.version}`,
          };
        }
        const generated = await generateWorkspaceArtifact(
          roots[0] ?? process.cwd(),
          {
            format,
            fileName:
              typeof args.fileName === 'string' && args.fileName.trim()
                ? args.fileName.trim()
                : `${document.title}-v${document.version}.${format}`,
            title: document.title,
            ...(format === 'md'
              ? { content: document.markdown }
              : format === 'json'
                ? { content: JSON.stringify(document, null, 2) }
                : format === 'csv'
                  ? {
                      sheets: [
                        {
                          name: '功能测试用例',
                          headers: [
                            '用例编号',
                            '用例标题',
                            '前置条件',
                            '操作步骤',
                            '预期结果',
                            '优先级',
                            '测试方法',
                          ],
                          rows: toPlainTestcaseRows(document),
                        },
                      ],
                    }
                  : format === 'xlsx'
                    ? { sheets: buildTestcaseXlsxSheets(document, workspace) }
                    : { content: document.markdown }),
          },
          { maxBytes: artifact.maxBytes, now: ctx.now },
        );
        const deliver = args.deliver === true;
        if (!deliver) {
          return jsonOutput(
            {
              version: document.version,
              sourceRevision: document.sourceRevision,
              path: generated.workspaceRelativePath,
              fileName: generated.fileName,
              format: generated.format,
              delivered: false,
              statistics: document.statistics,
              execution: document.execution,
              regressionCaseNumbers: document.regression.caseNumbers,
              issues: document.issues,
            },
            `已编译并生成 ${generated.fileName}`,
          );
        }
        if (isConsoleConversation(ctx)) {
          return jsonOutput(
            {
              version: document.version,
              sourceRevision: document.sourceRevision,
              path: generated.workspaceRelativePath,
              fileName: generated.fileName,
              format: generated.format,
              delivered: false,
              statistics: document.statistics,
              execution: document.execution,
              regressionCaseNumbers: document.regression.caseNumbers,
              issues: document.issues,
              message:
                '已在工作区生成产物并保存编译版本；当前为管理控制台会话，请前往「测试用例库」页面预览或直接下载文件。',
            },
            `已编译并生成 ${generated.fileName}（控制台会话可直接在测试用例库下载）`,
          );
        }
        const sent = await artifact.sender.send({
          conversationId: ctx.conversationId,
          conversationType: ctx.conversationType,
          senderStaffId: ctx.senderStaffId,
          filePath: generated.absolutePath,
          fileName: generated.fileName,
        });
        return jsonOutput(
          {
            version: document.version,
            sourceRevision: document.sourceRevision,
            path: generated.workspaceRelativePath,
            fileName: generated.fileName,
            delivered: sent.ok,
            error: sent.ok ? undefined : sent.error,
          },
          sent.ok
            ? `已编译并发送 ${generated.fileName}`
            : `已编译，但文件发送失败：${sent.error ?? '未知错误'}`,
        );
      },
    };
  }

  private async throwSyncedConflict(
    ctx: ExecutionContext,
    actor: TestcaseActor,
    workspaceId: string,
    error: TestcaseRevisionConflictError,
  ): Promise<never> {
    const latest = await this.options.service.get(actor, workspaceId).catch(() => null);
    if (latest) {
      bindWorkspace(ctx, latest.id, latest.revision);
      throw new Error(
        `${error.message}。已同步到最新 revision=${latest.revision}，请基于最新基线合并重试：\n${this.options.service.buildPromptSummary(latest)}`,
      );
    }
    throw error;
  }

  private actor(ctx: ExecutionContext): TestcaseActor {
    return {
      senderStaffId: ctx.senderStaffId,
      conversationId: ctx.conversationId,
      conversationType: ctx.conversationType,
      isAdmin: this.options.isAdmin(ctx.senderStaffId),
    };
  }
}

function isConsoleConversation(ctx: ExecutionContext): boolean {
  return (
    ctx.senderStaffId === 'admin-console' ||
    ctx.conversationId.startsWith('console:')
  );
}

function currentWorkspaceId(ctx: ExecutionContext): string | undefined {
  return ctx.testcaseWorkspaceBinding?.current?.workspaceId ?? ctx.workspaceId;
}

function bindWorkspace(
  ctx: ExecutionContext,
  workspaceId: string,
  baseRevision: number,
): void {
  ctx.workspaceId = workspaceId;
  if (ctx.testcaseWorkspaceBinding) {
    ctx.testcaseWorkspaceBinding.current = { workspaceId, baseRevision };
    ctx.testcaseWorkspaceBinding.autoSnapshotted = false;
  }
}

function assertActiveWorkspace(ctx: ExecutionContext, workspaceId: unknown): void {
  const requested = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!requested) throw new Error('workspaceId 必须是非空字符串');
  const activeWorkspaceId = currentWorkspaceId(ctx);
  if (activeWorkspaceId && activeWorkspaceId !== requested) {
    throw new Error('不能切换本次运行已绑定的测试用例工作区');
  }
}

function jsonOutput(value: unknown, summary: string): ToolExecutionOutput {
  return { text: JSON.stringify(value), summary };
}

function parseSelection(value: unknown): TestcaseCompileSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const strings = (key: string): string[] | undefined => {
    const list = raw[key];
    if (!Array.isArray(list)) return undefined;
    const cleaned = [
      ...new Set(
        list
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const modules = strings('modules');
  const requirementIds = strings('requirementIds');
  const caseIds = strings('caseIds');
  const priorities = strings('priorities')?.filter(
    (item): item is '高' | '中' | '低' => ['高', '中', '低'].includes(item),
  );
  const executionStatuses = strings('executionStatuses')?.filter(
    (item): item is TestcaseExecutionStatus =>
      ['untested', 'passed', 'failed', 'blocked'].includes(item),
  );
  const selection: TestcaseCompileSelection = {
    ...(modules ? { modules } : {}),
    ...(requirementIds ? { requirementIds } : {}),
    ...(caseIds ? { caseIds } : {}),
    ...(priorities?.length ? { priorities } : {}),
    ...(executionStatuses?.length ? { executionStatuses } : {}),
  };
  return Object.keys(selection).length > 0 ? selection : undefined;
}

function toCsv(document: CompiledTestcaseDocument): string {
  const headers = [
    '用例编号',
    '用例标题',
    '前置条件',
    '操作步骤',
    '预期结果',
    '优先级',
    '测试方法',
  ];
  return [headers, ...toPlainTestcaseRows(document)]
    .map((row) =>
      row
        .map((cell) => `"${cell.replace(/"/gu, '""').replace(/\r?\n/gu, '\n')}"`)
        .join(','),
    )
    .join('\n');
}
