import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  BookOutlined,
  CloudSyncOutlined,
  EditOutlined,
  GithubOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import type {
  GithubAdminStatus,
  GithubConnectionTestResult,
  HandbookSection,
  HandbookSectionKey,
  ProjectAdminEntry,
  ProjectHandbookRecord,
  ProjectHandbookResult,
  ProjectManualEntry,
  ProjectManualEntryInput,
  ProjectRecord,
  ProjectSearchResult,
  ProjectSensitivity,
  ProjectSnapshot,
  ProjectSnapshotStatus,
  ProjectSourceType,
  ProjectStatus,
  ProjectSyncJob,
  ProjectSyncStatus,
  ProjectVisibility,
} from '../types';

const SOURCE_LABEL: Record<ProjectSourceType, string> = {
  local: '本地目录',
  github: 'GitHub',
  manual: '手工维护',
};

const VISIBILITY_LABEL: Record<ProjectVisibility, string> = {
  team: '团队可见',
  private: '仅负责人',
  admin: '仅管理员',
};

const SENSITIVITY_LABEL: Record<ProjectSensitivity, string> = {
  team: '团队',
  private: '私有',
};

const SNAPSHOT_COLOR: Record<ProjectSnapshotStatus, string> = {
  building: 'blue',
  ready: 'green',
  failed: 'red',
  superseded: 'default',
};

const SNAPSHOT_LABEL: Record<ProjectSnapshotStatus, string> = {
  building: '构建中',
  ready: '就绪',
  failed: '失败',
  superseded: '已被替换',
};

const JOB_COLOR: Record<ProjectSyncStatus, string> = {
  queued: 'blue',
  running: 'orange',
  succeeded: 'green',
  failed: 'red',
};

const HANDBOOK_STATUS_COLOR: Record<ProjectHandbookRecord['status'], string> = {
  draft: 'gold',
  published: 'green',
  archived: 'default',
};

const HANDBOOK_SECTION_OPTIONS: Array<{
  value: HandbookSectionKey;
  label: string;
}> = [
  { value: 'overview', label: '概览' },
  { value: 'architecture', label: '架构' },
  { value: 'modules', label: '模块' },
  { value: 'data_model', label: '数据模型' },
  { value: 'config', label: '配置' },
  { value: 'deploy', label: '部署' },
  { value: 'operations', label: '运维' },
  { value: 'conventions', label: '约定' },
  { value: 'testing', label: '测试' },
  { value: 'decisions', label: '决策' },
  { value: 'faq', label: '常见问题' },
  { value: 'risks', label: '风险' },
];

function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 8) : '—';
}

interface ProjectForm {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  sourceType: ProjectSourceType;
  sourcePath: string;
  sourceRepo: string;
  sourceRef: string;
  sourceBranch: string;
  defaultBranch: string;
  ownerStaffIds: string[];
  visibility: ProjectVisibility;
  sensitivity: ProjectSensitivity;
  isDefault: boolean;
  enabled: boolean;
  autoSyncMinutes: number;
}

const DEFAULT_FORM: ProjectForm = {
  id: '',
  name: '',
  description: '',
  aliases: [],
  sourceType: 'local',
  sourcePath: '',
  sourceRepo: '',
  sourceRef: '',
  sourceBranch: '',
  defaultBranch: 'main',
  ownerStaffIds: [],
  visibility: 'team',
  sensitivity: 'team',
  isDefault: false,
  enabled: true,
  autoSyncMinutes: 0,
};

function toSource(values: ProjectForm): Record<string, unknown> {
  if (values.sourceType === 'manual') return { type: 'manual' };
  if (values.sourceType === 'local') {
    return {
      type: 'local',
      path: values.sourcePath.trim(),
      ...(values.sourceBranch.trim()
        ? { branch: values.sourceBranch.trim() }
        : {}),
    };
  }
  return {
    type: 'github',
    repo: values.sourceRepo.trim(),
    ...(values.sourceRef.trim() ? { ref: values.sourceRef.trim() } : {}),
  };
}

export default function ProjectsPage() {
  const [entries, setEntries] = useState<ProjectAdminEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const [form] = Form.useForm<ProjectForm>();
  const [modal, setModal] = useState<{ open: boolean; editing?: ProjectRecord }>({
    open: false,
  });
  const [sourceType, setSourceType] = useState<ProjectSourceType>('local');
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<ProjectAdminEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [jobs, setJobs] = useState<ProjectSyncJob[]>([]);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [handbook, setHandbook] = useState<ProjectHandbookResult | null>(null);
  const [handbookDraft, setHandbookDraft] =
    useState<ProjectHandbookRecord | null>(null);
  const [handbookError, setHandbookError] = useState('');
  const [handbookLoading, setHandbookLoading] = useState(false);
  const [sectionEditor, setSectionEditor] = useState<{
    open: boolean;
    key: HandbookSectionKey;
    title: string;
    markdown: string;
  }>({ open: false, key: 'overview', title: '', markdown: '' });
  const [savingDraft, setSavingDraft] = useState(false);
  const [handbookVersions, setHandbookVersions] = useState<
    ProjectHandbookRecord[]
  >([]);
  const [handbookAction, setHandbookAction] = useState<
    'generate' | 'publish' | ''
  >('');
  const [manualEntries, setManualEntries] = useState<ProjectManualEntry[]>([]);
  const [manualForm] = Form.useForm<ProjectManualEntryInput>();
  const [manualModal, setManualModal] = useState<{
    open: boolean;
    editing?: ProjectManualEntry;
  }>({ open: false });
  const [manualSaving, setManualSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<ProjectSearchResult | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [syncingId, setSyncingId] = useState('');
  const [githubStatus, setGithubStatus] = useState<GithubAdminStatus | null>(
    null,
  );
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubTestRepo, setGithubTestRepo] = useState('');
  const [githubTesting, setGithubTesting] = useState(false);
  const [githubTestResult, setGithubTestResult] =
    useState<GithubConnectionTestResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { projects } = await api.projects({
        ...(query.trim() ? { query: query.trim() } : {}),
      });
      setEntries(projects);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadGithubStatus = useCallback(async () => {
    setGithubLoading(true);
    try {
      const { status } = await api.githubStatus();
      setGithubStatus(status);
    } catch (error) {
      setGithubStatus(null);
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setGithubLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGithubStatus();
  }, [loadGithubStatus]);

  const runGithubTest = async () => {
    setGithubTesting(true);
    setGithubTestResult(null);
    try {
      const { result } = await api.testGithub(githubTestRepo.trim() || undefined);
      setGithubTestResult(result);
      if (result.ok) {
        message.success('GitHub 连通性正常');
      } else {
        message.warning(result.error ?? 'GitHub 连通性测试失败');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setGithubTesting(false);
    }
  };

  const refreshDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const [
        entryResult,
        snapshotsResult,
        jobsResult,
        statusResult,
        handbookResult,
        versionsResult,
        entriesResult,
      ] = await Promise.all([
        api.projects().then(({ projects }) => projects.find((item) => item.project.id === id) ?? null),
        api.projectSnapshots(id, 20),
        api.projectSyncJobs(id, 20),
        api
          .projectStatus(id)
          .then((result) => result.status)
          .catch(() => null),
        api
          .projectHandbook(id)
          .catch(() => null),
        api
          .projectHandbookVersions(id, 10)
          .then((result) => result.versions)
          .catch(() => [] as ProjectHandbookRecord[]),
        api
          .projectManualEntries(id)
          .then((result) => result.entries)
          .catch(() => [] as ProjectManualEntry[]),
      ]);
      if (entryResult) setDetail(entryResult);
      setSnapshots(snapshotsResult.snapshots);
      setJobs(jobsResult.jobs);
      setProjectStatus(statusResult);
      setHandbook(handbookResult?.handbook ?? null);
      setHandbookDraft(handbookResult?.draft ?? null);
      setHandbookVersions(versionsResult);
      setManualEntries(entriesResult);
      setHandbookError(handbookResult?.handbook ? '' : '项目手册尚未生成或接口未启用');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const openDetail = (entry: ProjectAdminEntry) => {
    setDetail(entry);
    setActiveTab('overview');
    setSearchQuery('');
    setSearchResult(null);
    void refreshDetail(entry.project.id);
  };

  const openCreate = () => {
    setModal({ open: true });
    setSourceType('local');
    form.setFieldsValue(DEFAULT_FORM);
  };

  const openEdit = (project: ProjectRecord) => {
    setModal({ open: true, editing: project });
    setSourceType(project.source.type);
    form.setFieldsValue({
      ...DEFAULT_FORM,
      id: project.id,
      name: project.name,
      description: project.description,
      aliases: project.aliases,
      sourceType: project.source.type,
      sourcePath: project.source.path ?? '',
      sourceRepo: project.source.repo ?? '',
      sourceRef: project.source.ref ?? '',
      sourceBranch: project.source.branch ?? '',
      defaultBranch: project.defaultBranch,
      ownerStaffIds: project.ownerStaffIds,
      visibility: project.visibility,
      sensitivity: project.sensitivity,
      isDefault: project.isDefault,
      enabled: project.enabled,
      autoSyncMinutes: project.autoSyncMinutes,
    });
  };

  const submit = async (values: ProjectForm) => {
    setSaving(true);
    try {
      if (values.sourceType === 'local' && !values.sourcePath.trim()) {
        message.error('本地项目必须填写服务器上的目录路径');
        return;
      }
      if (values.sourceType === 'github' && !values.sourceRepo.trim()) {
        message.error('GitHub 项目必须填写 owner/repo');
        return;
      }
      const common = {
        name: values.name.trim(),
        description: values.description.trim(),
        aliases: (values.aliases ?? []).map((item) => item.trim()).filter(Boolean),
        source: toSource(values),
        defaultBranch: values.defaultBranch.trim() || 'main',
        ownerStaffIds: (values.ownerStaffIds ?? [])
          .map((item) => item.trim())
          .filter(Boolean),
        visibility: values.visibility,
        sensitivity: values.sensitivity,
        isDefault: values.isDefault,
        enabled: values.enabled,
        autoSyncMinutes: values.autoSyncMinutes ?? 0,
      };
      if (modal.editing) {
        await api.updateProject(modal.editing.id, common);
        message.success('项目配置已更新，下次同步生效');
      } else {
        await api.createProject({ ...common, id: values.id.trim() });
        message.success('项目已创建，可立即发起首次同步');
      }
      setModal({ open: false });
      await load();
      if (detail) await refreshDetail(detail.project.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const sync = async (entry: ProjectAdminEntry) => {
    setSyncingId(entry.project.id);
    try {
      const { job } = await api.syncProject(entry.project.id);
      message.success(
        job.status === 'queued' ? '已加入同步队列' : '同步任务已启动',
      );
      await load();
      if (detail?.project.id === entry.project.id) {
        await refreshDetail(entry.project.id);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncingId('');
    }
  };

  const remove = async (entry: ProjectAdminEntry) => {
    try {
      await api.deleteProject(entry.project.id);
      message.success(`已删除项目「${entry.project.name}」`);
      if (detail?.project.id === entry.project.id) setDetail(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleEnabled = async (project: ProjectRecord, enabled: boolean) => {
    try {
      await api.updateProject(project.id, { enabled });
      await load();
      if (detail?.project.id === project.id) {
        await refreshDetail(project.id);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const runSearch = async () => {
    const projectId = detail?.project.id;
    const q = searchQuery.trim();
    if (!projectId || !q) return;
    setSearching(true);
    try {
      const { result } = await api.searchProject(projectId, q, 10);
      setSearchResult(result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSearching(false);
    }
  };

  const loadHandbook = async () => {
    if (!detail) return;
    setHandbookLoading(true);
    try {
      const { handbook: result, draft } = await api.projectHandbook(
        detail.project.id,
      );
      setHandbook(result);
      setHandbookDraft(draft);
      setHandbookError('');
    } catch (error) {
      setHandbookError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setHandbookLoading(false);
    }
  };

  const openSectionEditor = (section: HandbookSection) => {
    const draftSection = handbookDraft?.content.sections.find(
      (item) => item.key === section.key,
    );
    setSectionEditor({
      open: true,
      key: section.key,
      title: draftSection?.title ?? section.title,
      markdown: draftSection?.markdown ?? section.markdown,
    });
  };

  const saveSectionDraft = async () => {
    if (!detail) return;
    if (!sectionEditor.markdown.trim()) {
      message.error('章节内容不能为空');
      return;
    }
    setSavingDraft(true);
    try {
      const { handbook: record } = await api.saveProjectHandbookDraft(
        detail.project.id,
        {
          sections: [
            {
              key: sectionEditor.key,
              title: sectionEditor.title,
              markdown: sectionEditor.markdown,
            },
          ],
        },
      );
      message.success(`已保存为草稿 v${record.version}，确认后可发布`);
      setSectionEditor((prev) => ({ ...prev, open: false }));
      await refreshDetail(detail.project.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingDraft(false);
    }
  };

  const generateHandbook = async () => {
    if (!detail) return;
    setHandbookAction('generate');
    try {
      const { handbook: record } = await api.generateProjectHandbook(
        detail.project.id,
      );
      message.success(`已生成草稿 v${record.version}，确认内容后发布`);
      await refreshDetail(detail.project.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setHandbookAction('');
    }
  };

  const publishHandbook = async (version?: number) => {
    if (!detail) return;
    setHandbookAction('publish');
    try {
      const { handbook: record } = await api.publishProjectHandbook(
        detail.project.id,
        version,
      );
      message.success(`已发布项目手册 v${record.version}`);
      await refreshDetail(detail.project.id);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setHandbookAction('');
    }
  };

  const openManualEntry = (entry?: ProjectManualEntry) => {
    setManualModal({ open: true, ...(entry ? { editing: entry } : {}) });
    manualForm.setFieldsValue(
      entry
        ? {
            section: entry.section,
            title: entry.title,
            markdown: entry.markdown,
            visibility: entry.visibility,
            sensitivity: entry.sensitivity,
            injectToBrief: entry.injectToBrief,
            priority: entry.priority,
          }
        : {
            section: 'overview',
            title: '',
            markdown: '',
            visibility: 'team',
            sensitivity: 'team',
            injectToBrief: false,
            priority: 0,
          },
    );
  };

  const submitManualEntry = async (values: ProjectManualEntryInput) => {
    if (!detail) return;
    setManualSaving(true);
    try {
      if (manualModal.editing) {
        await api.updateProjectManualEntry(
          detail.project.id,
          manualModal.editing.id,
          values,
        );
        message.success('人工条目已更新');
      } else {
        await api.createProjectManualEntry(detail.project.id, values);
        message.success('人工条目已创建');
      }
      setManualModal({ open: false });
      await refreshDetail(detail.project.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setManualSaving(false);
    }
  };

  const removeManualEntry = async (entry: ProjectManualEntry) => {
    if (!detail) return;
    try {
      await api.deleteProjectManualEntry(detail.project.id, entry.id);
      message.success(`已删除条目「${entry.title}」`);
      await refreshDetail(detail.project.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const columns: ColumnsType<ProjectAdminEntry> = [
    {
      title: '项目',
      key: 'name',
      render: (_value, entry) => (
        <Space direction="vertical" size={0}>
          <Space wrap>
            <Typography.Text strong>{entry.project.name}</Typography.Text>
            {entry.project.isDefault ? <Tag color="gold">默认项目</Tag> : null}
            {!entry.project.enabled ? <Tag>已停用</Tag> : null}
            {entry.stale ? <Tag color="orange">快照过期</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {entry.project.id} · {entry.project.aliases.join('、') || '无别名'}
          </Typography.Text>
          {entry.project.description ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {entry.project.description}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '来源',
      key: 'source',
      width: 220,
      render: (_value, { project }) => (
        <Space direction="vertical" size={0}>
          <Tag color={project.source.type === 'github' ? 'geekblue' : 'default'}>
            {SOURCE_LABEL[project.source.type]}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {project.source.type === 'local'
              ? project.source.path
              : project.source.type === 'github'
                ? `${project.source.repo}${project.source.ref ? `@${project.source.ref}` : ''}`
                : '仅手册 / 人工条目'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '当前快照',
      key: 'snapshot',
      width: 220,
      render: (_value, { snapshot }) =>
        snapshot ? (
          <Space direction="vertical" size={0}>
            <Space>
              <Tag color={SNAPSHOT_COLOR[snapshot.status]}>
                {SNAPSHOT_LABEL[snapshot.status]}
              </Tag>
              <Typography.Text code>{shortSha(snapshot.commitSha)}</Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {snapshot.fileCount} 文件 · {snapshot.chunkCount} 分块 ·{' '}
              {formatBytes(snapshot.totalBytes)}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">尚未同步</Typography.Text>
        ),
    },
    {
      title: '手册',
      key: 'handbook',
      width: 110,
      render: (_value, { project }) => (
        <Typography.Text>
          v{project.handbookVersion || 0}
        </Typography.Text>
      ),
    },
    {
      title: '最近同步',
      key: 'lastSyncedAt',
      width: 170,
      render: (_value, { project }) => formatTime(project.lastSyncedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_value, entry) => (
        <Space wrap>
          <Button size="small" onClick={() => openDetail(entry)}>
            详情
          </Button>
          <Button
            size="small"
            icon={<CloudSyncOutlined />}
            loading={syncingId === entry.project.id}
            onClick={() => void sync(entry)}
          >
            同步
          </Button>
          <Button size="small" onClick={() => openEdit(entry.project)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除项目「${entry.project.name}」？`}
            description="会同时删除快照、分块索引与手册，无法恢复。"
            onConfirm={() => void remove(entry)}
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const detailProject = detail?.project;
  const latestDraft = handbookVersions.find(
    (item) => item.status === 'draft',
  );
  const displaySections =
    handbookDraft?.content.sections ?? handbook?.content.sections ?? [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        className="console-card"
        title={
          <Space>
            <GithubOutlined />
            GitHub 只读工具
          </Space>
        }
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={githubLoading}
            onClick={() => void loadGithubStatus()}
          >
            刷新状态
          </Button>
        }
      >
        {githubStatus ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[8, 8]}>
              <Tag color={githubStatus.enabled ? 'green' : 'default'}>
                GITHUB_ENABLED={String(githubStatus.enabled)}
              </Tag>
              <Tag color={githubStatus.ready ? 'green' : 'red'}>
                {githubStatus.ready ? '客户端就绪' : '客户端未就绪'}
              </Tag>
              <Tag color={githubStatus.toolsActive ? 'green' : 'orange'}>
                {githubStatus.toolsActive ? '工具可用' : '工具不可用'}
              </Tag>
              <Tag color={githubStatus.tokenConfigured ? 'green' : 'orange'}>
                {githubStatus.tokenConfigured ? 'Token 已配置' : 'Token 未配置'}
              </Tag>
              <Tag>API {githubStatus.apiBase}</Tag>
              <Tag>缓存 {githubStatus.cacheTtlSeconds}s</Tag>
              {githubStatus.defaultRepo ? (
                <Tag color="blue">默认 {githubStatus.defaultRepo}</Tag>
              ) : null}
            </Space>
            <Alert
              type={
                githubStatus.toolsActive
                  ? 'success'
                  : githubStatus.ready
                    ? 'warning'
                    : 'error'
              }
              showIcon
              message={githubStatus.hint}
              description={
                githubStatus.initError || githubStatus.defaultRepoError ? (
                  <>
                    {githubStatus.initError ? (
                      <div>初始化错误：{githubStatus.initError}</div>
                    ) : null}
                    {githubStatus.defaultRepoError ? (
                      <div>默认仓库读取失败：{githubStatus.defaultRepoError}</div>
                    ) : null}
                  </>
                ) : undefined
              }
            />
            <Space.Compact style={{ width: '100%', maxWidth: 620 }}>
              <Input
                allowClear
                placeholder={
                  githubStatus.defaultRepo
                    ? `留空使用默认仓库 ${githubStatus.defaultRepo}`
                    : 'owner/name'
                }
                value={githubTestRepo}
                onChange={(event) => setGithubTestRepo(event.target.value)}
                onPressEnter={() => {
                  if (!githubTesting) void runGithubTest();
                }}
              />
              <Button
                type="primary"
                loading={githubTesting}
                onClick={() => void runGithubTest()}
              >
                测试连通性
              </Button>
            </Space.Compact>
            {githubTestResult ? (
              <Alert
                type={githubTestResult.ok ? 'success' : 'error'}
                showIcon
                message={
                  githubTestResult.ok
                    ? `连接成功：${githubTestResult.fullName ?? githubTestResult.repo}（${githubTestResult.latencyMs} ms）`
                    : `连接失败：${githubTestResult.repo || '未指定仓库'}（${githubTestResult.latencyMs} ms）`
                }
                description={
                  githubTestResult.ok
                    ? `默认分支 ${githubTestResult.defaultBranch || '未知'}；${githubTestResult.private ? '私有仓库' : '公开仓库'}`
                    : `${githubTestResult.error ?? '未知错误'}${githubTestResult.rateLimited ? '（已触发 GitHub 限流）' : ''}`
                }
              />
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {githubLoading
              ? '正在读取 GitHub 运行状态…'
              : '无法读取 GitHub 运行状态，请确认管理 API 已启用。'}
          </Typography.Text>
        )}
      </Card>

      <Card
        title="项目手册与代码理解"
        className="console-card"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="搜索项目 id / 名称 / 别名"
              style={{ width: 260 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onSearch={(value) => setQuery(value)}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void load()}
            >
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              登记项目
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="项目同步会生成不可变快照：扫描代码、抽取符号与分块，供 project_search 检索；项目手册由确定性结构 + 人工条目 + 可选模型摘要组成，只把任务相关片段注入上下文。"
        />
        <Table<ProjectAdminEntry>
          rowKey={(entry) => entry.project.id}
          size="small"
          loading={loading}
          dataSource={entries}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            rowExpandable: (entry) => Boolean(entry.project.lastError),
            expandedRowRender: (entry) => (
              <Alert type="error" showIcon message={entry.project.lastError} />
            ),
          }}
          columns={columns}
        />
      </Card>

      <Modal
        title={modal.editing ? `编辑项目：${modal.editing.name}` : '登记项目'}
        open={modal.open}
        onCancel={() => setModal({ open: false })}
        onOk={() => void form.submit()}
        okText="保存"
        confirmLoading={saving}
        width={760}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item
              label="项目 ID"
              name="id"
              rules={[
                { required: true, message: '请填写项目 ID' },
                {
                  pattern: /^[a-z][a-z0-9-]{1,63}$/u,
                  message: '小写字母开头，仅含小写字母、数字和短横线',
                },
              ]}
              style={{ width: 300 }}
            >
              <Input placeholder="例如：anthys" disabled={Boolean(modal.editing)} />
            </Form.Item>
            <Form.Item
              label="项目名称"
              name="name"
              rules={[{ required: true, message: '请填写项目名称' }]}
              style={{ width: 400 }}
            >
              <Input placeholder="例如：Anthys 钉钉智能体" />
            </Form.Item>
          </Space>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} placeholder="一句话说明项目用途与边界" />
          </Form.Item>
          <Form.Item label="别名" name="aliases">
            <Select mode="tags" placeholder="输入别名后回车，便于提问时识别项目" />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item label="来源类型" name="sourceType" style={{ width: 200 }}>
              <Select
                options={Object.entries(SOURCE_LABEL).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(value: ProjectSourceType) => setSourceType(value)}
              />
            </Form.Item>
            {sourceType === 'local' ? (
              <>
                <Form.Item
                  label="服务器目录"
                  name="sourcePath"
                  rules={[{ required: true, message: '请填写服务器目录' }]}
                  style={{ width: 360 }}
                >
                  <Input placeholder="/srv/projects/anthys" />
                </Form.Item>
                <Form.Item label="分支（可选）" name="sourceBranch">
                  <Input placeholder="main" />
                </Form.Item>
              </>
            ) : null}
            {sourceType === 'github' ? (
              <>
                <Form.Item
                  label="仓库"
                  name="sourceRepo"
                  rules={[{ required: true, message: '请填写 owner/repo' }]}
                  style={{ width: 300 }}
                >
                  <Input placeholder="owner/repo" />
                </Form.Item>
                <Form.Item label="Ref（可选）" name="sourceRef">
                  <Input placeholder="main / v1.2.0 / commit" />
                </Form.Item>
              </>
            ) : null}
            {sourceType === 'manual' ? (
              <Form.Item label="说明">
                <Typography.Text type="secondary">
                  手工项目不扫描代码，只维护项目手册与人工条目。
                </Typography.Text>
              </Form.Item>
            ) : null}
          </Space>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item label="默认分支" name="defaultBranch">
              <Input style={{ width: 160 }} placeholder="main" />
            </Form.Item>
            <Form.Item label="可见范围" name="visibility">
              <Select
                style={{ width: 160 }}
                options={Object.entries(VISIBILITY_LABEL).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item label="敏感级别" name="sensitivity">
              <Select
                style={{ width: 140 }}
                options={Object.entries(SENSITIVITY_LABEL).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item label="自动同步（分钟，0=关闭）" name="autoSyncMinutes">
              <InputNumber min={0} max={1440} />
            </Form.Item>
          </Space>
          <Form.Item label="负责人 StaffId" name="ownerStaffIds">
            <Select mode="tags" placeholder="输入钉钉 StaffId 后回车" />
          </Form.Item>
          <Space size={24}>
            <Form.Item label="设为默认项目" name="isDefault" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="启用" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title={manualModal.editing ? '编辑人工条目' : '新增人工条目'}
        open={manualModal.open}
        onCancel={() => setManualModal({ open: false })}
        onOk={() => void manualForm.submit()}
        okText="保存"
        confirmLoading={manualSaving}
        width={760}
      >
        <Form form={manualForm} layout="vertical" onFinish={submitManualEntry}>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item
              label="分区"
              name="section"
              rules={[{ required: true, message: '请选择分区' }]}
              style={{ width: 220 }}
            >
              <Select options={HANDBOOK_SECTION_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="标题"
              name="title"
              rules={[{ required: true, message: '请填写标题' }]}
              style={{ width: 480 }}
            >
              <Input maxLength={200} placeholder="例如：发布流程与回滚步骤" />
            </Form.Item>
          </Space>
          <Form.Item
            label="内容（Markdown）"
            name="markdown"
            rules={[{ required: true, message: '请填写内容' }]}
          >
            <Input.TextArea
              rows={10}
              maxLength={20000}
              showCount
              placeholder="只写团队确认过的事实；不要粘贴密钥或令牌"
            />
          </Form.Item>
          <Space style={{ width: '100%' }} size={16}>
            <Form.Item label="可见范围" name="visibility">
              <Select
                style={{ width: 160 }}
                options={Object.entries(VISIBILITY_LABEL).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item label="敏感级别" name="sensitivity">
              <Select
                style={{ width: 140 }}
                options={Object.entries(SENSITIVITY_LABEL).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item
              label="注入项目摘要"
              name="injectToBrief"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item label="权重（-100 ~ 100）" name="priority">
              <InputNumber min={-100} max={100} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title={`编辑章节：${sectionEditor.title || sectionEditor.key}`}
        open={sectionEditor.open}
        onCancel={() =>
          setSectionEditor((prev) => ({ ...prev, open: false }))
        }
        onOk={() => void saveSectionDraft()}
        okText="保存为草稿"
        confirmLoading={savingDraft}
        width={880}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="保存会生成新的手册草稿版本，不会影响线上已发布内容；确认后再点「发布最新草稿」。"
          />
          <Input
            addonBefore="章节标题"
            value={sectionEditor.title}
            maxLength={100}
            onChange={(event) =>
              setSectionEditor((prev) => ({
                ...prev,
                title: event.target.value,
              }))
            }
          />
          <Input.TextArea
            rows={18}
            maxLength={20000}
            showCount
            value={sectionEditor.markdown}
            onChange={(event) =>
              setSectionEditor((prev) => ({
                ...prev,
                markdown: event.target.value,
              }))
            }
          />
        </Space>
      </Modal>

      <Drawer
        title={detailProject ? `项目详情：${detailProject.name}` : '项目详情'}
        open={Boolean(detail)}
        width={960}
        onClose={() => setDetail(null)}
        extra={
          detailProject ? (
            <Space>
              <Button
                icon={<CloudSyncOutlined />}
                loading={syncingId === detailProject.id}
                onClick={() => {
                  if (detail) void sync(detail);
                }}
              >
                同步
              </Button>
              <Button onClick={() => openEdit(detailProject)}>编辑</Button>
            </Space>
          ) : null
        }
      >
        {detail && detailProject ? (
          <Spin spinning={detailLoading}>
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
              items={[
                {
                  key: 'overview',
                  label: '概览',
                  children: (
                    <Space direction="vertical" size={14} style={{ width: '100%' }}>
                      {detailProject.lastError ? (
                        <Alert
                          type="error"
                          showIcon
                          message={detailProject.lastError}
                        />
                      ) : null}
                      <Descriptions size="small" bordered column={2}>
                        <Descriptions.Item label="项目 ID">
                          {detailProject.id}
                        </Descriptions.Item>
                        <Descriptions.Item label="名称">
                          {detailProject.name}
                        </Descriptions.Item>
                        <Descriptions.Item label="来源">
                          {SOURCE_LABEL[detailProject.source.type]}
                          {detailProject.source.type === 'local'
                            ? `：${detailProject.source.path}`
                            : detailProject.source.type === 'github'
                              ? `：${detailProject.source.repo}`
                              : ''}
                        </Descriptions.Item>
                        <Descriptions.Item label="默认分支">
                          {detailProject.defaultBranch}
                        </Descriptions.Item>
                        <Descriptions.Item label="最近提交">
                          {shortSha(detailProject.lastCommit)}
                        </Descriptions.Item>
                        <Descriptions.Item label="最近同步">
                          {formatTime(detailProject.lastSyncedAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="可见范围">
                          {VISIBILITY_LABEL[detailProject.visibility]}
                        </Descriptions.Item>
                        <Descriptions.Item label="敏感级别">
                          {SENSITIVITY_LABEL[detailProject.sensitivity]}
                        </Descriptions.Item>
                        <Descriptions.Item label="自动同步">
                          {detailProject.autoSyncMinutes > 0
                            ? `每 ${detailProject.autoSyncMinutes} 分钟`
                            : '关闭'}
                        </Descriptions.Item>
                        <Descriptions.Item label="启用">
                          <Switch
                            size="small"
                            checked={detailProject.enabled}
                            onChange={(checked) =>
                              void toggleEnabled(detailProject, checked)
                            }
                          />
                        </Descriptions.Item>
                        <Descriptions.Item label="别名" span={2}>
                          {detailProject.aliases.join('、') || '无'}
                        </Descriptions.Item>
                        <Descriptions.Item label="描述" span={2}>
                          {detailProject.description || '无'}
                        </Descriptions.Item>
                      </Descriptions>
                      {projectStatus ? (
                        <Descriptions
                          size="small"
                          bordered
                          column={2}
                          title="索引与运行状态"
                        >
                          <Descriptions.Item label="文件 / 符号 / 分块">
                            {projectStatus.index
                              ? `${projectStatus.index.files} / ${projectStatus.index.symbols} / ${projectStatus.index.chunks}`
                              : '尚未同步'}
                          </Descriptions.Item>
                          <Descriptions.Item label="已向量化分块">
                            {projectStatus.embeddingEnabled
                              ? `${projectStatus.index?.embeddedChunks ?? 0} / ${projectStatus.index?.chunks ?? 0}`
                              : '未启用 embedding'}
                          </Descriptions.Item>
                          <Descriptions.Item label="最近任务">
                            {projectStatus.latestJob
                              ? `${projectStatus.latestJob.status} · ${formatTime(projectStatus.latestJob.createdAt)}`
                              : '无'}
                          </Descriptions.Item>
                          <Descriptions.Item label="手册版本">
                            已发布 v{projectStatus.handbook.publishedVersion}
                            {projectStatus.handbook.draftVersion
                              ? ` · 草稿 v${projectStatus.handbook.draftVersion}`
                              : ''}
                          </Descriptions.Item>
                          <Descriptions.Item label="索引截断">
                            {projectStatus.index?.truncated ? (
                              <Tag color="orange">已达到扫描上限</Tag>
                            ) : (
                              <Tag color="green">完整</Tag>
                            )}
                          </Descriptions.Item>
                          <Descriptions.Item label="索引分支">
                            {projectStatus.index?.branch || '—'}
                          </Descriptions.Item>
                        </Descriptions>
                      ) : null}
                      {projectStatus?.latestJob?.error ? (
                        <Alert
                          type="error"
                          showIcon
                          message={`最近同步失败：${projectStatus.latestJob.error}`}
                        />
                      ) : null}
                      {projectStatus?.index &&
                      projectStatus.embeddingEnabled &&
                      projectStatus.index.embeddedChunks <
                        projectStatus.index.chunks ? (
                        <Alert
                          type="warning"
                          showIcon
                          message="部分分块没有向量，向量召回只覆盖已向量化部分；可重新同步补齐。"
                        />
                      ) : null}
                      {detail.stale ? (
                        <Alert
                          type="warning"
                          showIcon
                          message="当前快照落后于配置的提交或超过自动同步周期，建议立即同步。"
                        />
                      ) : null}
                    </Space>
                  ),
                },
                {
                  key: 'snapshots',
                  label: '快照',
                  children: (
                    <Table<ProjectSnapshot>
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={snapshots}
                      columns={[
                        {
                          title: '提交',
                          dataIndex: 'commitSha',
                          width: 110,
                          render: (value: string) => (
                            <Typography.Text code>{shortSha(value)}</Typography.Text>
                          ),
                        },
                        {
                          title: '分支',
                          dataIndex: 'branch',
                          width: 100,
                        },
                        {
                          title: '状态',
                          dataIndex: 'status',
                          width: 110,
                          render: (value: ProjectSnapshotStatus) => (
                            <Tag color={SNAPSHOT_COLOR[value]}>
                              {SNAPSHOT_LABEL[value]}
                            </Tag>
                          ),
                        },
                        {
                          title: '文件 / 分块 / 符号',
                          key: 'counts',
                          render: (_value, row) =>
                            `${row.fileCount} / ${row.chunkCount} / ${row.symbolCount}`,
                        },
                        {
                          title: '大小',
                          dataIndex: 'totalBytes',
                          width: 100,
                          render: (value: number) => formatBytes(value),
                        },
                        {
                          title: '完成时间',
                          dataIndex: 'finishedAt',
                          width: 170,
                          render: (value: number | undefined) => formatTime(value),
                        },
                      ]}
                      expandable={{
                        rowExpandable: (row) => Boolean(row.error),
                        expandedRowRender: (row) => (
                          <Alert type="error" showIcon message={row.error} />
                        ),
                      }}
                    />
                  ),
                },
                {
                  key: 'jobs',
                  label: '同步任务',
                  children: (
                    <Table<ProjectSyncJob>
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={jobs}
                      columns={[
                        { title: '任务', dataIndex: 'id', width: 200, ellipsis: true },
                        {
                          title: '触发',
                          dataIndex: 'trigger',
                          width: 80,
                          render: (value: string) =>
                            ({ manual: '手动', schedule: '定时', startup: '启动' })[
                              value
                            ] ?? value,
                        },
                        {
                          title: '状态',
                          dataIndex: 'status',
                          width: 100,
                          render: (value: ProjectSyncStatus) => (
                            <Tag color={JOB_COLOR[value]}>{value}</Tag>
                          ),
                        },
                        {
                          title: '统计',
                          key: 'stats',
                          render: (_value, row) =>
                            row.stats
                              ? `${row.stats.files} 文件 / ${row.stats.chunks} 分块 / ${row.stats.durationMs}ms`
                              : '—',
                        },
                        {
                          title: '创建时间',
                          dataIndex: 'createdAt',
                          width: 170,
                          render: (value: number) => formatTime(value),
                        },
                      ]}
                      expandable={{
                        rowExpandable: (row) => Boolean(row.error),
                        expandedRowRender: (row) => (
                          <Alert type="error" showIcon message={row.error} />
                        ),
                      }}
                    />
                  ),
                },
                {
                  key: 'search',
                  label: '检索预览',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Input.Search
                        placeholder="输入问题或符号，验证混合检索效果"
                        enterButton="检索"
                        loading={searching}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        onSearch={() => void runSearch()}
                      />
                      {searchResult ? (
                        <>
                          <Space wrap>
                            <Tag>提交 {shortSha(searchResult.commit)}</Tag>
                            <Tag>命中 {searchResult.total}</Tag>
                            {searchResult.stale ? (
                              <Tag color="orange">快照可能过期</Tag>
                            ) : null}
                            {searchResult.truncated ? (
                              <Tag color="blue">结果已截断</Tag>
                            ) : null}
                            {searchResult.warning ? (
                              <Typography.Text type="warning">
                                {searchResult.warning}
                              </Typography.Text>
                            ) : null}
                          </Space>
                          {searchResult.hits.length === 0 ? (
                            <Empty description="没有命中，检查快照是否就绪" />
                          ) : (
                            searchResult.hits.map((hit, index) => (
                              <Card
                                key={`${hit.path}-${hit.startLine}-${index}`}
                                size="small"
                                title={
                                  <Space wrap>
                                    <Typography.Text code>
                                      {hit.path}:{hit.startLine}-{hit.endLine}
                                    </Typography.Text>
                                    {hit.symbol ? <Tag>{hit.symbol}</Tag> : null}
                                    <Tag color="blue">{hit.match}</Tag>
                                    <Tag>{hit.score.toFixed(3)}</Tag>
                                  </Space>
                                }
                              >
                                <pre
                                  style={{
                                    margin: 0,
                                    whiteSpace: 'pre-wrap',
                                    fontSize: 12,
                                    maxHeight: 240,
                                    overflow: 'auto',
                                  }}
                                >
                                  {hit.content}
                                </pre>
                              </Card>
                            ))
                          )}
                        </>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  key: 'handbook',
                  label: '项目手册',
                  children: (
                    <Spin spinning={handbookLoading}>
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Space wrap>
                          <Button icon={<ReloadOutlined />} onClick={() => void loadHandbook()}>
                            刷新手册
                          </Button>
                          <Button
                            type="primary"
                            loading={handbookAction === 'generate'}
                            onClick={() => void generateHandbook()}
                          >
                            生成草稿
                          </Button>
                          <Popconfirm
                            title="发布最新草稿？"
                            description="发布后对话侧 project_handbook 会立即读取新版本。"
                            disabled={!latestDraft}
                            onConfirm={() => void publishHandbook()}
                          >
                            <Button
                              loading={handbookAction === 'publish'}
                              disabled={!latestDraft}
                            >
                              发布最新草稿
                            </Button>
                          </Popconfirm>
                          {handbook ? (
                            <>
                              <Tag>v{handbook.version}</Tag>
                              <Tag color="blue">{handbook.status}</Tag>
                              <Tag>提交 {shortSha(handbook.commit)}</Tag>
                              {handbook.stale ? (
                                <Tag color="orange">快照已更新</Tag>
                              ) : null}
                            </>
                          ) : null}
                          {latestDraft ? (
                            <Tag color="gold">草稿 v{latestDraft.version} 待发布</Tag>
                          ) : null}
                          {handbookDraft ? (
                            <Tag color="gold">
                              当前显示草稿 v{handbookDraft.version}
                            </Tag>
                          ) : null}
                        </Space>
                        {handbookError ? (
                          <Alert type="warning" showIcon message={handbookError} />
                        ) : null}
                        {displaySections.length > 0 ? (
                          <Collapse
                            items={displaySections.map((section) => ({
                              key: section.key,
                              label: (
                                <Space>
                                  <BookOutlined />
                                  <Typography.Text strong>
                                    {section.title}
                                  </Typography.Text>
                                  <Tag>{section.origin}</Tag>
                                  <Button
                                    type="link"
                                    size="small"
                                    icon={<EditOutlined />}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openSectionEditor(section);
                                    }}
                                  >
                                    编辑
                                  </Button>
                                </Space>
                              ),
                              children: (
                                <pre
                                  style={{
                                    margin: 0,
                                    whiteSpace: 'pre-wrap',
                                    fontSize: 12,
                                  }}
                                >
                                  {section.markdown}
                                </pre>
                              ),
                            }))}
                          />
                        ) : (
                          <Empty description="尚未生成项目手册，可基于当前快照生成确定性草稿" />
                        )}
                        <Typography.Title level={5} style={{ margin: 0 }}>
                          版本记录
                        </Typography.Title>
                        <Table<ProjectHandbookRecord>
                          rowKey="id"
                          size="small"
                          pagination={false}
                          dataSource={handbookVersions}
                          locale={{ emptyText: '暂无手册版本' }}
                          columns={[
                            {
                              title: '版本',
                              dataIndex: 'version',
                              width: 80,
                              render: (value: number) => `v${value}`,
                            },
                            {
                              title: '状态',
                              dataIndex: 'status',
                              width: 100,
                              render: (value: ProjectHandbookRecord['status']) => (
                                <Tag color={HANDBOOK_STATUS_COLOR[value]}>
                                  {value}
                                </Tag>
                              ),
                            },
                            {
                              title: '提交',
                              dataIndex: 'commitSha',
                              width: 110,
                              render: (value: string) => (
                                <Typography.Text code>
                                  {shortSha(value)}
                                </Typography.Text>
                              ),
                            },
                            {
                              title: '生成方式',
                              dataIndex: 'generatedBy',
                              width: 90,
                            },
                            {
                              title: '创建时间',
                              dataIndex: 'createdAt',
                              width: 170,
                              render: (value: number) => formatTime(value),
                            },
                            {
                              title: '操作',
                              key: 'actions',
                              width: 100,
                              render: (_value, record) =>
                                record.status === 'draft' ? (
                                  <Popconfirm
                                    title={`发布 v${record.version}？`}
                                    onConfirm={() =>
                                      void publishHandbook(record.version)
                                    }
                                  >
                                    <Button size="small" type="link">
                                      发布
                                    </Button>
                                  </Popconfirm>
                                ) : (
                                  '—'
                                ),
                            },
                          ]}
                        />
                      </Space>
                    </Spin>
                  ),
                },
                {
                  key: 'manual',
                  label: `人工条目（${manualEntries.length}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => openManualEntry()}
                      >
                        新增条目
                      </Button>
                      <Table<ProjectManualEntry>
                        rowKey="id"
                        size="small"
                        pagination={false}
                        dataSource={manualEntries}
                        locale={{ emptyText: '暂无人工条目' }}
                        columns={[
                          { title: '标题', dataIndex: 'title', width: 220 },
                          {
                            title: '分区',
                            dataIndex: 'section',
                            width: 120,
                            render: (value: HandbookSectionKey) =>
                              HANDBOOK_SECTION_OPTIONS.find(
                                (option) => option.value === value,
                              )?.label ?? value,
                          },
                          {
                            title: '注入摘要',
                            dataIndex: 'injectToBrief',
                            width: 100,
                            render: (value: boolean) =>
                              value ? <Tag color="green">是</Tag> : <Tag>否</Tag>,
                          },
                          { title: '权重', dataIndex: 'priority', width: 80 },
                          {
                            title: '更新人',
                            dataIndex: 'updatedBy',
                            width: 140,
                          },
                          {
                            title: '更新时间',
                            dataIndex: 'updatedAt',
                            width: 170,
                            render: (value: number) => formatTime(value),
                          },
                          {
                            title: '操作',
                            key: 'actions',
                            width: 130,
                            render: (_value, record) => (
                              <Space>
                                <Button
                                  size="small"
                                  type="link"
                                  onClick={() => openManualEntry(record)}
                                >
                                  编辑
                                </Button>
                                <Popconfirm
                                  title={`删除条目「${record.title}」？`}
                                  onConfirm={() => void removeManualEntry(record)}
                                >
                                  <Button size="small" type="link" danger>
                                    删除
                                  </Button>
                                </Popconfirm>
                              </Space>
                            ),
                          },
                        ]}
                        expandable={{
                          expandedRowRender: (row) => (
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                fontSize: 12,
                              }}
                            >
                              {row.markdown}
                            </pre>
                          ),
                        }}
                      />
                    </Space>
                  ),
                },
              ]}
            />
          </Spin>
        ) : null}
      </Drawer>
    </Space>
  );
}
