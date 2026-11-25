import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import {
  buildTestcaseXlsxSheets,
  compileTestcaseWorkspace,
  toPlainTestcaseRows,
} from '../../testcase/TestcaseCompiler.js';
import type {
  TestcaseActor,
  TestcaseWorkspaceService,
} from '../../testcase/TestcaseWorkspaceService.js';
import { TestcaseRevisionConflictError } from '../../testcase/TestcaseWorkspaceStore.js';
import {
  buildDocxBuffer,
  buildXlsxBuffer,
} from '../../tools/artifacts/ArtifactGenerator.js';
import type {
  CompiledTestcaseDocument,
  TestcaseOutputPreferences,
  TestcaseWorkspacePatch,
} from '../../types/testcase-workspace.js';
import {
  readBoolean,
  readJsonBody,
  readNumber,
  readString,
  recordWebAudit,
  webActor,
} from './configRoutes.js';

export interface TestcaseRouteDeps {
  configCenter: DynamicConfigCenter;
  workspaces: TestcaseWorkspaceService;
}

type ExportFormat = 'md' | 'json' | 'csv' | 'xlsx' | 'docx';

const EXPORT_HEADERS = [
  '用例编号',
  '用例标题',
  '前置条件',
  '操作步骤',
  '预期结果',
  '优先级',
  '测试方法',
];

const CONTENT_TYPES: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function adminActor(c: Parameters<typeof webActor>[0]): TestcaseActor {
  return {
    senderStaffId: webActor(c),
    conversationId: '',
    conversationType: '1',
    isAdmin: true,
  };
}

function mapWorkspaceError(error: unknown): never {
  if (error instanceof TestcaseRevisionConflictError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof Error && error.message.includes('不存在')) {
    throw new HTTPException(404, { message: error.message });
  }
  if (error instanceof Error) {
    throw new HTTPException(400, { message: error.message });
  }
  throw error;
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function buildCsvExport(document: CompiledTestcaseDocument): Buffer {
  const lines = [EXPORT_HEADERS, ...toPlainTestcaseRows(document)].map((row) =>
    row.map(escapeCsvCell).join(','),
  );
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function safeFileStem(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._-]+/u, '')
    .slice(0, 80);
  return cleaned || 'testcase';
}

function readOutputPreferences(
  raw: unknown,
): Partial<TestcaseOutputPreferences> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HTTPException(400, { message: 'outputPreferences 必须是对象' });
  }
  const obj = raw as Record<string, unknown>;
  const result: Partial<TestcaseOutputPreferences> = {};
  for (const key of [
    'screenshotMarkers',
    'includeDataChecklist',
    'includeTraceability',
    'includeAutomationFeasibility',
  ] as const) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== 'boolean') {
        throw new HTTPException(400, { message: `${key} 必须是布尔值` });
      }
      result[key] = obj[key];
    }
  }
  return result;
}

export function createTestcaseRoutes(deps: TestcaseRouteDeps): Hono {
  const app = new Hono();

  app.get('/testcases/workspaces', async (c) => {
    const query = c.req.query('query')?.trim() || undefined;
    const conversationId = c.req.query('conversationId')?.trim() || undefined;
    const ownerStaffId = c.req.query('ownerStaffId')?.trim() || undefined;
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const includeArchivedRaw = c.req.query('includeArchived');
    const includeArchived = includeArchivedRaw !== 'false';
    const rawLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(Math.trunc(rawLimit), 100))
      : 50;

    const items = await deps.workspaces.query(adminActor(c), {
      ...(query ? { query } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(ownerStaffId ? { ownerStaffId } : {}),
      ...(projectId ? { projectId } : {}),
      includeArchived,
      limit,
    });
    return c.json({ ok: true, items });
  });

  app.get('/testcases/workspaces/:id', async (c) => {
    const id = c.req.param('id').trim();
    const actor = adminActor(c);
    try {
      const workspace = await deps.workspaces.get(actor, id);
      const versions = await deps.workspaces.versions(actor, id, 50);
      const nextVersion = (versions[0]?.version ?? 0) + 1;
      const preview = compileTestcaseWorkspace(workspace, { version: nextVersion });
      return c.json({ ok: true, workspace, versions, preview });
    } catch (error) {
      mapWorkspaceError(error);
    }
  });

  app.patch('/testcases/workspaces/:id', async (c) => {
    const id = c.req.param('id').trim();
    const body = await readJsonBody(c);
    const actor = adminActor(c);
    const title = readString(body, 'title');
    const rawProjectId = body.projectId;
    if (
      rawProjectId !== undefined &&
      rawProjectId !== null &&
      typeof rawProjectId !== 'string'
    ) {
      throw new HTTPException(400, { message: 'projectId 必须是字符串或 null' });
    }
    const archived = readBoolean(body, 'archived');
    const outputPreferences = readOutputPreferences(body.outputPreferences);
    const explicitBaseRevision = readNumber(body, 'baseRevision');

    try {
      const before = await deps.workspaces.get(actor, id);
      const baseRevision =
        explicitBaseRevision !== undefined
          ? Math.trunc(explicitBaseRevision)
          : before.revision;
      const patch: TestcaseWorkspacePatch = {
        ...(title !== undefined ? { title } : {}),
        ...(rawProjectId !== undefined ? { projectId: rawProjectId } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(outputPreferences ? { outputPreferences } : {}),
      };
      const updated = await deps.workspaces.update(actor, id, baseRevision, patch);
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'UPDATE_TESTCASE_WORKSPACE',
        before as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      );
      return c.json({ ok: true, workspace: updated });
    } catch (error) {
      mapWorkspaceError(error);
    }
  });

  app.post('/testcases/workspaces/:id/compile', async (c) => {
    const id = c.req.param('id').trim();
    const body = await readJsonBody(c).catch(() => ({}));
    const actor = adminActor(c);
    const label = readString(body, 'label');
    const explicitBaseRevision = readNumber(body, 'baseRevision');

    try {
      const before = await deps.workspaces.get(actor, id);
      const baseRevision =
        explicitBaseRevision !== undefined
          ? Math.trunc(explicitBaseRevision)
          : before.revision;
      const document = await deps.workspaces.compile(actor, {
        workspaceId: id,
        baseRevision,
        ...(label?.trim() ? { label: label.trim() } : {}),
      });
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'COMPILE_TESTCASE_WORKSPACE',
        { workspaceId: id, revision: before.revision },
        {
          workspaceId: id,
          version: document.version,
          sourceRevision: document.sourceRevision,
          totalCases: document.statistics.total,
        },
      );
      return c.json({ ok: true, document });
    } catch (error) {
      mapWorkspaceError(error);
    }
  });

  app.get('/testcases/workspaces/:id/export', async (c) => {
    const id = c.req.param('id').trim();
    const formatRaw = (c.req.query('format') ?? 'xlsx').trim().toLowerCase();
    if (!['md', 'json', 'csv', 'xlsx', 'docx'].includes(formatRaw)) {
      throw new HTTPException(400, {
        message: 'format 仅支持 md / json / csv / xlsx / docx',
      });
    }
    const format = formatRaw as ExportFormat;
    const versionParam = c.req.query('version');
    const actor = adminActor(c);

    try {
      const workspace = await deps.workspaces.get(actor, id);
      const versions = await deps.workspaces.versions(actor, id, 100);
      let document: CompiledTestcaseDocument;
      if (versionParam !== undefined && versionParam.trim() !== '') {
        const targetVer = Number(versionParam);
        if (!Number.isSafeInteger(targetVer) || targetVer < 1) {
          throw new HTTPException(400, { message: 'version 必须是正整数' });
        }
        const matched = versions.find((item) => item.version === targetVer);
        if (!matched) {
          throw new HTTPException(404, {
            message: `历史合稿版本 v${targetVer} 不存在`,
          });
        }
        document = matched.document;
      } else {
        document = compileTestcaseWorkspace(workspace, {
          version: (versions[0]?.version ?? 0) + 1,
        });
      }

      let payload: Buffer;
      switch (format) {
        case 'md':
          payload = Buffer.from(document.markdown, 'utf8');
          break;
        case 'json':
          payload = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
          break;
        case 'csv':
          payload = buildCsvExport(document);
          break;
        case 'xlsx':
          payload = buildXlsxBuffer(buildTestcaseXlsxSheets(document, workspace));
          break;
        case 'docx':
          payload = buildDocxBuffer(document.markdown, document.title);
          break;
      }

      const fileName = `${safeFileStem(document.title)}-v${document.version}.${format}`;
      return new Response(new Uint8Array(payload), {
        status: 200,
        headers: {
          'content-type': CONTENT_TYPES[format],
          'content-disposition': `attachment; filename="testcase-v${document.version}.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      mapWorkspaceError(error);
    }
  });

  app.delete('/testcases/workspaces/:id', async (c) => {
    const id = c.req.param('id').trim();
    const actor = adminActor(c);
    try {
      const before = await deps.workspaces.get(actor, id);
      const removed = await deps.workspaces.delete(actor, id);
      await recordWebAudit(
        deps.configCenter,
        webActor(c),
        'DELETE_TESTCASE_WORKSPACE',
        { id: before.id, title: before.title, revision: before.revision },
        { removed },
      );
      return c.json({ ok: true, removed });
    } catch (error) {
      mapWorkspaceError(error);
    }
  });

  return app;
}
