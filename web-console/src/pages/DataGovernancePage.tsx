import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api } from '../api';
import type {
  CleanupResult,
  DeletionResult,
  RetentionKind,
  RetentionPolicy,
  RetentionStats,
} from '../types';

const KIND_LABEL: Record<RetentionKind, string> = {
  messages: '会话消息',
  summaries: '情景摘要',
  traces: 'ReAct 轨迹',
  audit: '管理审计',
  usage: '用量流水',
  attachments: '附件目录',
};

const POLICY_FIELDS: Array<{
  key: keyof RetentionPolicy;
  label: string;
  suffix: string;
}> = [
  { key: 'messagesDays', label: '消息与摘要', suffix: '天' },
  { key: 'tracesDays', label: 'ReAct 轨迹', suffix: '天' },
  { key: 'attachmentsHours', label: '入站附件', suffix: '小时' },
  { key: 'auditDays', label: '管理审计', suffix: '天' },
  { key: 'usageDays', label: '用量流水', suffix: '天' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const columns: ColumnsType<{ kind: RetentionKind; total: number; expired: number }> = [
  {
    title: '数据表',
    dataIndex: 'kind',
    render: (kind: RetentionKind) => KIND_LABEL[kind],
  },
  { title: '当前行数', dataIndex: 'total' },
  {
    title: '超出保留期',
    dataIndex: 'expired',
    render: (value: number) =>
      value > 0 ? <Tag color="orange">{value}</Tag> : <Tag>0</Tag>,
  },
];

export default function DataGovernancePage() {
  const [stats, setStats] = useState<RetentionStats | null>(null);
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [conversationId, setConversationId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [deletion, setDeletion] = useState<DeletionResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.governance();
      setStats(result);
      setDraft(result.policy);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const savePolicy = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.updateRetention(draft);
      setDraft(result.policy);
      message.success('保留策略已更新');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runCleanup = async (dryRun: boolean) => {
    setLoading(true);
    try {
      const result = await api.cleanupData(dryRun);
      setCleanupResult(result.result);
      message.success(dryRun ? '已完成 dry-run 统计' : '清理完成');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const removeConversation = async () => {
    try {
      const result = await api.deleteConversationData(conversationId.trim());
      setDeletion(result.result);
      setConversationId('');
      message.success('会话数据已删除');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const removeUser = async () => {
    try {
      const result = await api.deleteUserData(staffId.trim());
      setDeletion(result.result);
      setStaffId('');
      message.success('员工数据已删除');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const rows = (Object.keys(KIND_LABEL) as RetentionKind[]).map((kind) => ({
    kind,
    total: stats?.totals[kind] ?? 0,
    expired: stats?.expired[kind] ?? 0,
  }));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="日志与 ReAct 轨迹在落库/输出前会脱敏手机号、邮箱、身份证号与常见密钥格式；关闭 DATA_REDACTION_ENABLED 可保留原文用于排障。"
      />

      <Card
        title="保留期策略"
        loading={loading && !draft}
        extra={
          <Button type="primary" loading={saving} onClick={() => void savePolicy()}>
            保存
          </Button>
        }
      >
        <Row gutter={[16, 16]}>
          {POLICY_FIELDS.map((field) => (
            <Col key={field.key} xs={24} md={8} lg={4}>
              <Typography.Text type="secondary">{field.label}</Typography.Text>
              <InputNumber
                min={1}
                style={{ width: '100%', marginTop: 4 }}
                addonAfter={field.suffix}
                value={draft?.[field.key]}
                onChange={(value) =>
                  setDraft((prev) =>
                    prev && value !== null
                      ? { ...prev, [field.key]: Number(value) }
                      : prev,
                  )
                }
              />
            </Col>
          ))}
        </Row>
      </Card>

      <Card title="数据概览" loading={loading}>
        <Table
          rowKey="kind"
          size="small"
          pagination={false}
          columns={columns}
          dataSource={rows}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          附件占用：{formatBytes(stats?.attachmentBytes ?? 0)}；定时清理按 DATA_CLEANUP_INTERVAL_SECONDS 执行，集群模式下仅 leader 执行。
        </Typography.Paragraph>
      </Card>

      <Card title="过期数据清理">
        <Space wrap>
          <Button onClick={() => void runCleanup(true)} loading={loading}>
            预览（dry-run）
          </Button>
          <Popconfirm
            title="确认立即删除所有超出保留期的数据？"
            description="该操作不可撤销，请先执行 dry-run 预览。"
            onConfirm={() => void runCleanup(false)}
          >
            <Button danger loading={loading}>
              立即清理
            </Button>
          </Popconfirm>
        </Space>
        {cleanupResult && (
          <Descriptions
            size="small"
            column={3}
            style={{ marginTop: 16 }}
            items={[
              {
                key: 'mode',
                label: '模式',
                children: cleanupResult.dryRun ? 'dry-run（未删除）' : '已执行删除',
              },
              {
                key: 'duration',
                label: '耗时',
                children: `${cleanupResult.finishedAt - cleanupResult.startedAt} ms`,
              },
              ...(Object.keys(cleanupResult.deleted) as RetentionKind[]).map(
                (kind) => ({
                  key: kind,
                  label: KIND_LABEL[kind],
                  children: String(cleanupResult.deleted[kind]),
                }),
              ),
            ]}
          />
        )}
      </Card>

      <Card title="级联删除">
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="删除会同时清理消息、摘要、轨迹、用量、反馈、旁听策略、定时任务与对应附件目录，且不可恢复。"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="钉钉会话 ID（conversationId）"
                value={conversationId}
                onChange={(event) => setConversationId(event.target.value)}
              />
              <Popconfirm
                title="按会话级联删除全部数据？"
                onConfirm={() => void removeConversation()}
                disabled={!conversationId.trim()}
              >
                <Button danger disabled={!conversationId.trim()}>
                  删除会话数据
                </Button>
              </Popconfirm>
            </Space.Compact>
          </Col>
          <Col xs={24} lg={12}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="员工 staffId"
                value={staffId}
                onChange={(event) => setStaffId(event.target.value)}
              />
              <Popconfirm
                title="按员工级联删除单聊与个人数据？"
                onConfirm={() => void removeUser()}
                disabled={!staffId.trim()}
              >
                <Button danger disabled={!staffId.trim()}>
                  删除员工数据
                </Button>
              </Popconfirm>
            </Space.Compact>
          </Col>
        </Row>
        {deletion && (
          <Descriptions
            size="small"
            column={3}
            style={{ marginTop: 16 }}
            items={[
              { key: 'target', label: '删除对象', children: deletion.target },
              {
                key: 'attachments',
                label: '附件目录',
                children: String(deletion.attachmentsRemoved),
              },
              ...Object.entries(deletion.deleted).map(([key, value]) => ({
                key,
                label: key,
                children: String(value),
              })),
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
