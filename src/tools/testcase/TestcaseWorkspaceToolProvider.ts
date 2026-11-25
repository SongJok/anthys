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
  TestcaseWorkspacePatch,
} from '../../types/testcase-workspace.js';
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

const PATCH_SCHEMA = {
  type: 'object',
  description:
    '增量补丁。只提交本次变化，不要求填写所有字段。upsert 使用稳定语义 id；removeIds 删除条目。',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    projectId: { type: ['string', 'null'] },
    requirements: {
      type: 'object',
      properties: {
        upsert: { type: 'array', items: { $ref: '#/$defs/requirement' } },
        removeIds: { type: 'array', items: { type: 'string' } },
      },
    },
    evidence: {
      type: 'object',
      properties: {
        upsert: { type: 'array', items: { $ref: '#/$defs/evidence' } },
        removeIds: { type: 'array', items: { type: 'string' } },
      },
    },
    cases: {
      type: 'object',
      properties: {
        upsert: { type: 'array', items: { $ref: '#/$defs/case' } },
        removeIds: { type: 'array', items: { type: 'string' } },
      },
    },
    decisions: {
      type: 'object',
      properties: {
        upsert: { type: 'array', items: { $ref: '#/$defs/decision' } },
        removeIds: { type: 'array', items: { type: 'string' } },
      },
    },
    openQuestions: {
      type: 'object',
      properties: {
        upsert: { type: 'array', items: { $ref: '#/$defs/question' } },
        removeIds: { type: 'array', items: { type: 'string' } },
      },
    },
    outputPreferences: {
      type: 'object',
      properties: {
        screenshotMarkers: { type: 'boolean' },
        includeDataChecklist: { type: 'boolean' },
        includeTraceability: { type: 'boolean' },
        includeAutomationFeasibility: { type: 'boolean' },
      },
    },
  },
  $defs: {
    requirement: {
      type: 'object',
      required: ['id', 'title', 'description', 'module', 'sourceRef', 'rules', 'constraints', 'status'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        module: { type: 'string' },
        sourceRef: { type: 'string' },
        rules: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'superseded', 'unresolved'] },
      },
    },
    evidence: {
      type: 'object',
      required: ['id', 'type', 'sourceRef', 'collectedAt', 'scope', 'summary', 'confidence', 'requirementIds', 'conflictsWith'],
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
        requirementIds: { type: 'array', items: { type: 'string' } },
        conflictsWith: { type: 'array', items: { type: 'string' } },
        datasetRef: { type: 'string' },
      },
    },
    case: {
      type: 'object',
      required: [
        'id',
        'module',
        'title',
        'preconditions',
        'steps',
        'expectedResults',
        'priority',
        'testMethod',
        'scenarioType',
        'requirementIds',
        'evidenceIds',
        'assumptions',
        'status',
      ],
      properties: {
        id: { type: 'string' },
        module: { type: 'string' },
        title: { type: 'string' },
        preconditions: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
        expectedResults: { type: 'array', items: { type: 'string' } },
        priority: { type: 'string', enum: ['高', '中', '低'] },
        testMethod: {
          type: 'string',
          enum: ['需求分析法', '等价类划分法', '边界值分析法', '场景法', '错误猜测法'],
        },
        scenarioType: {
          type: 'string',
          enum: ['normal', 'exception', 'boundary', 'other'],
        },
        requirementIds: { type: 'array', items: { type: 'string' } },
        evidenceIds: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['draft', 'ready', 'superseded'] },
      },
    },
    decision: {
      type: 'object',
      required: ['id', 'topic', 'value', 'createdAt'],
      properties: {
        id: { type: 'string' },
        topic: { type: 'string' },
        value: { type: 'string' },
        sourceMessageId: { type: 'string' },
        createdAt: { type: 'number' },
      },
    },
    question: {
      type: 'object',
      required: ['id', 'question', 'blocking', 'requirementIds', 'status'],
      properties: {
        id: { type: 'string' },
        question: { type: 'string' },
        blocking: { type: 'boolean' },
        requirementIds: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['open', 'resolved'] },
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
      description: '列出当前用户在当前会话可继续的测试用例工作区。不是流程命令，只在需要恢复或切换工作时使用。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      risk: 'read',
      source: 'testcase-workspace',
      executeStructured: async (args) => {
        const items = await this.options.service.list(
          this.actor(ctx),
          typeof args.conversationId === 'string' ? args.conversationId : undefined,
          typeof args.limit === 'number' ? args.limit : undefined,
        );
        return jsonOutput(items, `找到 ${items.length} 个测试用例工作区`);
      },
    };
  }

  private getTool(ctx: ExecutionContext): WorkspaceToolDefinition {
    return {
      name: 'testcase_workspace_get',
      description: '读取工作区摘要或指定部分。默认只读摘要；需要细节时再读取 requirements/cases/evidence 等部分。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          section: {
            type: 'string',
            enum: ['summary', 'requirements', 'cases', 'evidence', 'decisions', 'questions', 'full'],
            default: 'summary',
          },
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
        const workspace = await this.options.service.get(
          this.actor(ctx),
          String(args.workspaceId),
        );
        const section = String(args.section ?? 'summary');
        const offset = Math.max(0, Number(args.offset ?? 0));
        const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 200));
        if (section === 'summary') {
          return {
            text: this.options.service.buildPromptSummary(workspace),
            summary: `读取工作区 ${workspace.id} 摘要`,
          };
        }
        if (section === 'full') {
          return jsonOutput(workspace, `读取工作区 ${workspace.id} 完整内容`);
        }
        const source =
          section === 'requirements'
            ? workspace.state.requirements
            : section === 'cases'
              ? workspace.state.cases
              : section === 'evidence'
                ? workspace.state.evidence
                : section === 'decisions'
                  ? workspace.state.decisions
                  : workspace.state.openQuestions;
        return jsonOutput(
          {
            workspaceId: workspace.id,
            revision: workspace.revision,
            section,
            total: source.length,
            items: source.slice(offset, offset + limit),
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
        if (ctx.jobId && activeWorkspaceId && activeWorkspaceId !== workspaceId) {
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
        if (ctx.jobId && currentWorkspaceId(ctx)) {
          throw new Error('后台任务不能创建或切换测试用例工作区');
        }
        const workspace = await this.options.service.create(this.actor(ctx), {
          title: String(args.title),
          ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
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
        '增量更新需求、证据、草稿、决策或输出偏好。只传本次变化；baseRevision 必须来自最近一次读取。内部草稿保存无外部副作用。',
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
        const workspace = await this.options.service.update(
          this.actor(ctx),
          String(args.workspaceId),
          Number(args.baseRevision),
          args.patch as TestcaseWorkspacePatch,
        );
        bindWorkspace(ctx, workspace.id, workspace.revision);
        return {
          text: this.options.service.buildPromptSummary(workspace),
          summary: `已更新工作区 ${workspace.id} 到 r${workspace.revision}`,
        };
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
        '对当前工作区执行确定性去重、排序、编号、统计、追溯检查并生成版本。可只返回内容，也可生成 md/json/csv/xlsx/docx 文件；deliver=true 时才投递到当前会话。',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          baseRevision: { type: 'integer', minimum: 1 },
          label: { type: 'string' },
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
        const document = await this.options.service.compile(this.actor(ctx), {
          workspaceId: String(args.workspaceId),
          baseRevision: Number(args.baseRevision),
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
        });
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
                  ? { content: toCsv(document) }
                  : format === 'xlsx'
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
                            rows: document.rows,
                          },
                        ],
                      }
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
              issues: document.issues,
            },
            `已编译并生成 ${generated.fileName}`,
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

  private actor(ctx: ExecutionContext): TestcaseActor {
    return {
      senderStaffId: ctx.senderStaffId,
      conversationId: ctx.conversationId,
      conversationType: ctx.conversationType,
      isAdmin: this.options.isAdmin(ctx.senderStaffId),
    };
  }
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
  return [headers, ...document.rows]
    .map((row) =>
      row
        .map((cell) => `"${cell.replace(/"/gu, '""').replace(/\r?\n/gu, '\n')}"`)
        .join(','),
    )
    .join('\n');
}
