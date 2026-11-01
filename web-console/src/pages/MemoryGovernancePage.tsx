import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  SemanticMemory,
  SemanticMemoryKind,
  SemanticMemoryScope,
  SemanticMemorySensitivity,
  SemanticMemoryStatus,
} from '../types';

const SCOPE_OPTIONS: Array<{ value: SemanticMemoryScope; label: string }> = [
  { value: 'global', label: '全局' },
  { value: 'group', label: '群记忆' },
  { value: 'user', label: '个人记忆' },
];

const KIND_OPTIONS: Array<{ value: SemanticMemoryKind; label: string }> = [
  { value: 'profile', label: '画像' },
  { value: 'terminology', label: '术语' },
];

const STATUS_OPTIONS: Array<{ value: SemanticMemoryStatus; label: string }> = [
  { value: 'active', label: '生效' },
  { value: 'retired', label: '停用' },
];

const SENSITIVITY_OPTIONS: Array<{
  value: SemanticMemorySensitivity;
  label: string;
}> = [
  { value: 'normal', label: '普通' },
  { value: 'private', label: '私密' },
  { value: 'sensitive', label: '敏感' },
];

const SCOPE_LABEL: Record<SemanticMemoryScope, string> = {
  global: '全局',
  group: '群记忆',
  user: '个人记忆',
};

const SCOPE_COLOR: Record<SemanticMemoryScope, string> = {
  global: 'blue',
  group: 'purple',
  user: 'green',
};

const KIND_LABEL: Record<SemanticMemoryKind, string> = {
  profile: '画像',
  terminology: '术语',
};

const SENSITIVITY_LABEL: Record<SemanticMemorySensitivity, string> = {
  normal: '普通',
  private: '私密',
  sensitive: '敏感',
};

const SENSITIVITY_COLOR: Record<SemanticMemorySensitivity, string> = {
  normal: 'default',
  private: 'orange',
  sensitive: 'red',
};

interface Filters {
  scope?: SemanticMemoryScope;
  kind?: SemanticMemoryKind;
  status?: SemanticMemoryStatus;
  subjectKey: string;
  query: string;
}

const EMPTY_FILTERS: Filters = { subjectKey: '', query: '' };

interface MemoryForm {
  content: string;
  keywords: string[];
  shareableInGroup: boolean;
  sensitivity: SemanticMemorySensitivity;
  status: SemanticMemoryStatus;
  confidence: number;
  expiresAtText: string;
}

function parseShanghaiDateTime(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const ms = Date.parse(
    /[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized)
      ? normalized
      : `${normalized}+08:00`,
  );
  if (!Number.isFinite(ms)) {
    throw new Error('有效期格式无法识别，请用 YYYY-MM-DD HH:mm');
  }
  return ms;
}

export default function MemoryGovernancePage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<SemanticMemory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [form] = Form.useForm<MemoryForm>();
  const [modal, setModal] = useState<{ open: boolean; memory?: SemanticMemory }>({
    open: false,
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.memories({
        ...(filters.scope ? { scope: filters.scope } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.subjectKey.trim()
          ? { subjectKey: filters.subjectKey.trim() }
          : {}),
        ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
        limit: 200,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (memory: SemanticMemory) => {
    setModal({ open: true, memory });
    form.setFieldsValue({
      content: memory.content,
      keywords: memory.keywords,
      shareableInGroup: memory.shareableInGroup,
      sensitivity: memory.sensitivity,
      status: memory.status,
      confidence: memory.confidence,
      expiresAtText: memory.expiresAt
        ? formatShanghaiDateTime(memory.expiresAt)
        : '',
    });
  };

  const save = async (values: MemoryForm) => {
    if (!modal.memory) return;
    let expiresAt: number | null;
    try {
      expiresAt = parseShanghaiDateTime(values.expiresAtText ?? '');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return;
    }
    setSaving(true);
    try {
      await api.updateMemory(modal.memory.id, {
        content: values.content.trim(),
        keywords: (values.keywords ?? []).map((item) => item.trim()).filter(Boolean),
        shareableInGroup: values.shareableInGroup,
        sensitivity: values.sensitivity,
        status: values.status,
        confidence: values.confidence,
        expiresAt,
      });
      message.success('记忆治理字段已更新');
      setModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleShareable = async (memory: SemanticMemory, checked: boolean) => {
    try {
      await api.updateMemory(memory.id, { shareableInGroup: checked });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (memory: SemanticMemory) => {
    try {
      await api.deleteMemory(memory.id);
      message.success('记忆已删除');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const now = Date.now();

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="群聊召回个人记忆时只读取「可在群内共享」的条目；不同群的群记忆互不可见；全局记忆对所有会话可见。停用或已过期的记忆不会参与召回。"
      />

      <Card
        title="语义记忆治理"
        className="console-card"
        extra={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            allowClear
            placeholder="作用域"
            style={{ width: 130 }}
            options={SCOPE_OPTIONS}
            value={filters.scope}
            onChange={(value) =>
              setFilters((prev) => ({ ...prev, scope: value }))
            }
          />
          <Select
            allowClear
            placeholder="类型"
            style={{ width: 120 }}
            options={KIND_OPTIONS}
            value={filters.kind}
            onChange={(value) => setFilters((prev) => ({ ...prev, kind: value }))}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 120 }}
            options={STATUS_OPTIONS}
            value={filters.status}
            onChange={(value) =>
              setFilters((prev) => ({ ...prev, status: value }))
            }
          />
          <Input
            allowClear
            placeholder="主体标识（personKey / conversationId）"
            style={{ width: 280 }}
            value={filters.subjectKey}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, subjectKey: event.target.value }))
            }
          />
          <Input.Search
            allowClear
            placeholder="搜索记忆内容"
            style={{ width: 240 }}
            value={filters.query}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, query: event.target.value }))
            }
            onSearch={(value) =>
              setFilters((prev) => ({ ...prev, query: value }))
            }
          />
          <Typography.Text type="secondary">共 {total} 条</Typography.Text>
        </Space>

        <Table<SemanticMemory>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={items}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (memory) => (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <pre
                  style={{
                    background: '#f6f8ff',
                    padding: 12,
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                  }}
                >
                  {memory.content}
                </pre>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  来源：{memory.sourceConversationType === '1' ? '单聊' : memory.sourceConversationType === '2' ? '群聊' : '未知'}
                  {' · '}
                  {memory.sourceConversationId ?? '-'}
                  {memory.sourceMessageId ? ` / ${memory.sourceMessageId}` : ''}
                  {' · 创建于 '}
                  {formatShanghaiDateTime(memory.createdAt)}
                </Typography.Text>
              </Space>
            ),
          }}
          columns={[
            {
              title: '作用域',
              dataIndex: 'scope',
              width: 100,
              render: (value: SemanticMemoryScope) => (
                <Tag color={SCOPE_COLOR[value]}>{SCOPE_LABEL[value]}</Tag>
              ),
            },
            {
              title: '主体',
              dataIndex: 'subjectKey',
              width: 200,
              ellipsis: true,
              render: (value: string, row) =>
                row.scope === 'global' ? (
                  <Typography.Text type="secondary">全局</Typography.Text>
                ) : (
                  <Tooltip title={value}>{value}</Tooltip>
                ),
            },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 90,
              render: (value: SemanticMemoryKind) => KIND_LABEL[value],
            },
            {
              title: '内容',
              dataIndex: 'content',
              ellipsis: true,
            },
            {
              title: '可在群内共享',
              dataIndex: 'shareableInGroup',
              width: 130,
              render: (value: boolean, row) => (
                <Tooltip
                  title={
                    row.scope === 'user'
                      ? '个人记忆只有开启后才能被群聊召回'
                      : '全局/群记忆默认在对应范围内可见'
                  }
                >
                  <Switch
                    size="small"
                    checked={value}
                    onChange={(checked) => void toggleShareable(row, checked)}
                  />
                </Tooltip>
              ),
            },
            {
              title: '敏感级别',
              dataIndex: 'sensitivity',
              width: 100,
              render: (value: SemanticMemorySensitivity) => (
                <Tag color={SENSITIVITY_COLOR[value]}>
                  {SENSITIVITY_LABEL[value]}
                </Tag>
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 80,
              render: (value: SemanticMemoryStatus) =>
                value === 'active' ? (
                  <Tag color="green">生效</Tag>
                ) : (
                  <Tag>停用</Tag>
                ),
            },
            {
              title: '置信度',
              dataIndex: 'confidence',
              width: 80,
              render: (value: number) => value.toFixed(2),
            },
            {
              title: '有效期至',
              dataIndex: 'expiresAt',
              width: 160,
              render: (value: number | null) => {
                if (!value) return <Tag>永久</Tag>;
                if (value <= now) return <Tag color="red">已过期</Tag>;
                return formatShanghaiDateTime(value);
              },
            },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              width: 160,
              render: (value: number) => formatShanghaiDateTime(value),
            },
            {
              title: '操作',
              key: 'actions',
              width: 130,
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除该条记忆？"
                    description="删除后无法恢复，后续对话也不会再召回。"
                    onConfirm={() => void remove(row)}
                  >
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="编辑记忆治理"
        open={modal.open}
        confirmLoading={saving}
        onCancel={() => setModal({ open: false })}
        onOk={() => void form.submit()}
        okText="保存"
        width={720}
      >
        {modal.memory && (
          <Typography.Paragraph type="secondary">
            {SCOPE_LABEL[modal.memory.scope]} · {modal.memory.subjectKey} ·
            修改内容会清空向量，下一次召回先走关键词匹配
          </Typography.Paragraph>
        )}
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item
            label="内容"
            name="content"
            rules={[{ required: true, message: '记忆内容不能为空' }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item label="关键词" name="keywords">
            <Select mode="tags" placeholder="输入关键词后回车" />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item
              label="可在群内共享"
              name="shareableInGroup"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item label="敏感级别" name="sensitivity">
              <Select style={{ width: 140 }} options={SENSITIVITY_OPTIONS} />
            </Form.Item>
            <Form.Item label="状态" name="status">
              <Select style={{ width: 120 }} options={STATUS_OPTIONS} />
            </Form.Item>
            <Form.Item label="置信度（0-1）" name="confidence">
              <InputNumber min={0} max={1} step={0.05} />
            </Form.Item>
          </Space>
          <Form.Item
            label="有效期至（Asia/Shanghai）"
            name="expiresAtText"
            extra="格式 YYYY-MM-DD HH:mm；留空表示永不过期。"
          >
            <Input placeholder="2026-12-31 23:59" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
