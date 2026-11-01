import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  SkillAdminView,
  SkillDraftInput,
  SkillPreviewResult,
  SkillResourceInfo,
  SkillRisk,
  SkillSource,
  SkillValidationResult,
  SkillVisibility,
} from '../types';

const SOURCE_LABEL: Record<SkillSource, string> = {
  builtin: '内置',
  local: '本地',
  plugin: '插件',
};

const SOURCE_COLOR: Record<SkillSource, string> = {
  builtin: 'blue',
  local: 'green',
  plugin: 'purple',
};

const RISK_LABEL: Record<SkillRisk, string> = {
  read: '只读',
  write: '写入',
  destructive: '高危',
};

const RISK_COLOR: Record<SkillRisk, string> = {
  read: 'green',
  write: 'gold',
  destructive: 'red',
};

const VISIBILITY_LABEL: Record<SkillVisibility, string> = {
  public: '公开',
  admin: '仅管理员',
};

const EMPTY_FORM: SkillDraftInput = {
  name: '',
  description: '',
  version: '1.0.0',
  whenToUse: '',
  tags: [],
  allowedTools: [],
  risk: 'read',
  visibility: 'public',
  maxInstructionChars: 4_000,
  body: '',
};

function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return formatShanghaiDateTime(ms);
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillAdminView[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SkillSource | undefined>();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillAdminView | null>(null);
  const [form, setForm] = useState<SkillDraftInput>(EMPTY_FORM);
  const [validation, setValidation] = useState<SkillValidationResult | null>(null);
  const [saving, setSaving] = useState(false);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewQuery, setPreviewQuery] = useState('');
  const [preview, setPreview] = useState<SkillPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [resourcePath, setResourcePath] = useState('');
  const [resourceContent, setResourceContent] = useState('');
  const [resourceView, setResourceView] = useState<{ path: string; content: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { skills: items } = await api.skills({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(sourceFilter ? { source: sourceFilter } : {}),
      });
      setSkills(items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query, sourceFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setValidation(null);
    setEditorOpen(true);
  };

  const openEdit = (skill: SkillAdminView) => {
    setEditing(skill);
    setForm({
      name: skill.name,
      description: skill.description,
      version: skill.version,
      whenToUse: skill.whenToUse,
      tags: skill.tags,
      allowedTools: skill.allowedTools,
      risk: skill.risk,
      visibility: skill.visibility,
      maxInstructionChars: skill.maxInstructionChars,
      body: skill.body,
    });
    setValidation(null);
    setResourcePath('');
    setResourceContent('');
    setEditorOpen(true);
  };

  const handleValidate = async () => {
    try {
      const { result } = await api.validateSkill(form);
      setValidation(result);
      if (result.ok) message.success('校验通过');
      else message.warning(result.errors.join('；'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editing) {
        await api.updateSkill(editing.id, form);
      } else {
        await api.createSkill(form);
      }
      message.success(editing ? '技能已保存' : '技能已创建');
      setEditorOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (skill: SkillAdminView, enabled: boolean) => {
    try {
      await api.setSkillEnabled(skill.id, enabled);
      message.success(enabled ? '技能已启用' : '技能已停用');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async (skill: SkillAdminView) => {
    try {
      await api.deleteSkill(skill.id);
      message.success('本地技能已删除');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleReload = async () => {
    try {
      const result = await api.reloadSkills();
      message.success(`已重载 ${result.loaded} 个技能，失败 ${result.errors.length} 个`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const openPreview = async () => {
    setPreviewOpen(true);
    setPreviewing(true);
    try {
      setPreview(
        await api.previewSkills({
          query: previewQuery,
          conversationType: '1',
          isAdmin: true,
        }),
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewing(false);
    }
  };

  const handleWriteResource = async () => {
    if (!editing) return;
    if (!resourcePath.trim() || !resourceContent) {
      message.warning('请填写资源路径和内容');
      return;
    }
    try {
      await api.writeSkillResource(editing.id, resourcePath.trim(), resourceContent);
      message.success('资源已写入');
      setResourcePath('');
      setResourceContent('');
      const { skill } = await api.skill(editing.id);
      setEditing(skill);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleReadResource = async (resource: SkillResourceInfo) => {
    if (!editing) return;
    try {
      const { resource: content } = await api.readSkillResource(
        editing.id,
        resource.path,
      );
      setResourceView({ path: resource.path, content: content.content });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDeleteResource = async (resource: SkillResourceInfo) => {
    if (!editing) return;
    try {
      await api.deleteSkillResource(editing.id, resource.path);
      message.success('资源已删除');
      const { skill } = await api.skill(editing.id);
      setEditing(skill);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const columns: ColumnsType<SkillAdminView> = [
    {
      title: '技能',
      dataIndex: 'name',
      render: (_value, skill) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{skill.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {skill.id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 90,
      render: (source: SkillSource) => (
        <Tag color={SOURCE_COLOR[source]}>{SOURCE_LABEL[source]}</Tag>
      ),
    },
    { title: '版本', dataIndex: 'version', width: 90 },
    {
      title: '说明',
      dataIndex: 'description',
      render: (_value, skill) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{skill.description}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            适用：{skill.whenToUse}
          </Typography.Text>
          {skill.loadError ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              加载失败：{skill.loadError}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '风险',
      dataIndex: 'risk',
      width: 80,
      render: (risk: SkillRisk) => <Tag color={RISK_COLOR[risk]}>{RISK_LABEL[risk]}</Tag>,
    },
    {
      title: '可见性',
      dataIndex: 'visibility',
      width: 110,
      render: (visibility: SkillVisibility) => (
        <Tag color={visibility === 'admin' ? 'volcano' : 'default'}>
          {VISIBILITY_LABEL[visibility]}
        </Tag>
      ),
    },
    {
      title: '近 7 天使用',
      dataIndex: 'uses',
      width: 140,
      render: (_value, skill) => (
        <Space direction="vertical" size={0}>
          <span>{skill.uses} 次</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatTime(skill.lastUsedAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (enabled: boolean, skill) => (
        <Switch
          size="small"
          checked={enabled}
          disabled={Boolean(skill.loadError)}
          onChange={(next) => void handleToggle(skill, next)}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_value, skill) => (
        <Space>
          {skill.source === 'local' ? (
            <Button size="small" onClick={() => openEdit(skill)}>
              编辑
            </Button>
          ) : null}
          <Button size="small" onClick={() => void openPreview()}>
            目录预览
          </Button>
          {skill.source === 'local' ? (
            <Popconfirm
              title="删除本地技能？"
              description="将删除 skills/local 下对应目录，无法撤销。"
              okText="删除"
              okButtonProps={{ danger: true }}
              onConfirm={() => void handleDelete(skill)}
            >
              <Button size="small" danger>
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space wrap>
          <Input.Search
            placeholder="搜索名称 / 描述 / 触发条件"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void load()}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            placeholder="来源"
            value={sourceFilter}
            onChange={setSourceFilter}
            style={{ width: 140 }}
            options={(Object.keys(SOURCE_LABEL) as SkillSource[]).map((source) => ({
              value: source,
              label: SOURCE_LABEL[source],
            }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button onClick={() => void handleReload()}>重载技能目录</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建本地技能
          </Button>
        </Space>
      </Card>

      <Card>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={skills}
          pagination={{ pageSize: 20, showSizeChanger: false }}
        />
      </Card>

      <Modal
        title={editing ? `编辑技能：${editing.name}` : '新建本地技能'}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        width={860}
        onOk={() => void handleSave()}
        okText="保存"
        confirmLoading={saving}
        okButtonProps={{ disabled: validation !== null && !validation.ok }}
        footer={(originNode) => (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button icon={<ThunderboltOutlined />} onClick={() => void handleValidate()}>
              校验
            </Button>
            <Space>{originNode}</Space>
          </Space>
        )}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {validation ? (
            <Alert
              type={validation.ok ? 'success' : 'error'}
              showIcon
              message={validation.ok ? '校验通过' : '校验失败'}
              description={
                <Space direction="vertical" size={2}>
                  {validation.errors.map((error) => (
                    <span key={error}>{error}</span>
                  ))}
                  {validation.warnings.map((warning) => (
                    <Typography.Text key={warning} type="warning">
                      {warning}
                    </Typography.Text>
                  ))}
                  <Typography.Text type="secondary">
                    正文字节数：{validation.bodyBytes}
                  </Typography.Text>
                </Space>
              }
            />
          ) : null}
          <Space wrap>
            <div>
              <Typography.Text type="secondary">技能 name</Typography.Text>
              <Input
                value={form.name}
                disabled={Boolean(editing)}
                placeholder="小写字母/数字/短横线"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                style={{ width: 220 }}
              />
            </div>
            <div>
              <Typography.Text type="secondary">版本</Typography.Text>
              <Input
                value={form.version}
                onChange={(event) => setForm({ ...form, version: event.target.value })}
                style={{ width: 120 }}
              />
            </div>
            <div>
              <Typography.Text type="secondary">风险</Typography.Text>
              <Select
                value={form.risk}
                onChange={(risk) => setForm({ ...form, risk })}
                style={{ width: 120 }}
                options={(Object.keys(RISK_LABEL) as SkillRisk[]).map((risk) => ({
                  value: risk,
                  label: RISK_LABEL[risk],
                }))}
              />
            </div>
            <div>
              <Typography.Text type="secondary">可见性</Typography.Text>
              <Select
                value={form.visibility}
                onChange={(visibility) => setForm({ ...form, visibility })}
                style={{ width: 140 }}
                options={(Object.keys(VISIBILITY_LABEL) as SkillVisibility[]).map(
                  (visibility) => ({
                    value: visibility,
                    label: VISIBILITY_LABEL[visibility],
                  }),
                )}
              />
            </div>
            <div>
              <Typography.Text type="secondary">正文上限</Typography.Text>
              <InputNumber
                min={1000}
                max={8000}
                step={500}
                value={form.maxInstructionChars}
                onChange={(value) =>
                  setForm({ ...form, maxInstructionChars: value ?? 4_000 })
                }
                style={{ width: 120 }}
              />
            </div>
          </Space>
          <div>
            <Typography.Text type="secondary">description（≤160 字符）</Typography.Text>
            <Input
              value={form.description}
              maxLength={160}
              showCount
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
          <div>
            <Typography.Text type="secondary">when_to_use（≤200 字符）</Typography.Text>
            <Input
              value={form.whenToUse}
              maxLength={200}
              showCount
              onChange={(event) => setForm({ ...form, whenToUse: event.target.value })}
            />
          </div>
          <Space wrap>
            <div>
              <Typography.Text type="secondary">标签</Typography.Text>
              <Select
                mode="tags"
                value={form.tags}
                onChange={(tags) => setForm({ ...form, tags })}
                style={{ width: 300 }}
                placeholder="回车添加"
              />
            </div>
            <div>
              <Typography.Text type="secondary">允许工具</Typography.Text>
              <Select
                mode="tags"
                value={form.allowedTools}
                onChange={(allowedTools) => setForm({ ...form, allowedTools })}
                style={{ width: 300 }}
                placeholder="可选，如 project_search"
              />
            </div>
          </Space>
          <div>
            <Typography.Text type="secondary">SKILL.md 正文</Typography.Text>
            <Input.TextArea
              rows={14}
              value={form.body}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
              style={{ fontFamily: 'monospace' }}
            />
          </div>

          {editing ? (
            <Card size="small" title="资源文件（references/ 等）">
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {editing.resources.map((resource) => (
                  <Space key={resource.path}>
                    <Typography.Text code>{resource.path}</Typography.Text>
                    <Typography.Text type="secondary">{resource.sizeBytes} B</Typography.Text>
                    <Button size="small" onClick={() => void handleReadResource(resource)}>
                      查看
                    </Button>
                    <Popconfirm
                      title="删除该资源文件？"
                      onConfirm={() => void handleDeleteResource(resource)}
                    >
                      <Button size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ))}
                {editing.resources.length === 0 ? (
                  <Typography.Text type="secondary">暂无资源文件</Typography.Text>
                ) : null}
                <Input
                  placeholder="资源路径，例如 references/checklist.md"
                  value={resourcePath}
                  onChange={(event) => setResourcePath(event.target.value)}
                />
                <Input.TextArea
                  rows={4}
                  placeholder="资源内容（≤256KB 文本）"
                  value={resourceContent}
                  onChange={(event) => setResourceContent(event.target.value)}
                  style={{ fontFamily: 'monospace' }}
                />
                <Button onClick={() => void handleWriteResource()}>写入资源</Button>
              </Space>
            </Card>
          ) : null}
        </Space>
      </Modal>

      <Drawer
        title="技能目录预览"
        open={previewOpen}
        width={720}
        onClose={() => setPreviewOpen(false)}
        extra={
          <Button onClick={() => void openPreview()} loading={previewing}>
            重新生成
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input.Search
            placeholder="输入用户问题，预览命中的技能"
            value={previewQuery}
            onChange={(event) => setPreviewQuery(event.target.value)}
            onSearch={() => void openPreview()}
          />
          {preview ? (
            <>
              <Alert
                type={preview.truncated ? 'warning' : 'info'}
                showIcon
                message={`命中 ${preview.entries.filter((entry) => entry.matched).length} 个，共 ${preview.entries.length} 个候选`}
                description={preview.truncated ? '目录超出预算，已截断并提示 skill_search。' : undefined}
              />
              <Card size="small" title="注入系统提示词">
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{preview.prompt || '（空）'}</pre>
              </Card>
              <Table
                rowKey={(entry) => entry.skill.id}
                size="small"
                pagination={false}
                dataSource={preview.entries}
                columns={[
                  { title: '技能', dataIndex: ['skill', 'name'] },
                  { title: '来源', dataIndex: ['skill', 'source'] },
                  { title: '得分', dataIndex: 'score', width: 80 },
                  {
                    title: '命中',
                    dataIndex: 'matched',
                    width: 70,
                    render: (matched: boolean) => (matched ? '是' : '否'),
                  },
                ]}
              />
            </>
          ) : (
            <Typography.Text type="secondary">
              {previewing ? '正在生成…' : '输入问题后点击搜索'}
            </Typography.Text>
          )}
        </Space>
      </Drawer>

      <Modal
        title={resourceView?.path}
        open={Boolean(resourceView)}
        onCancel={() => setResourceView(null)}
        footer={null}
        width={760}
      >
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 480, overflow: 'auto' }}>
          {resourceView?.content}
        </pre>
      </Modal>
    </Space>
  );
}
