import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { api } from '../api';
import type { DefaultGroupPolicy, GroupPolicy, KnownGroup } from '../types';

interface PolicyForm {
  bystanderEnabled: boolean;
  proactiveReplyEnabled: boolean;
  cooldownSeconds: number;
  slidingWindowSize: number;
  confidenceThreshold: number;
  triggerTopics: string[];
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<KnownGroup[]>([]);
  const [defaults, setDefaults] = useState<DefaultGroupPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<{ open: boolean; group?: KnownGroup }>({ open: false });
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<PolicyForm>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.groups();
      setGroups(result.groups);
      setDefaults(result.defaults);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (group: KnownGroup) => {
    const source: GroupPolicy | undefined = group.policy;
    setModal({ open: true, group });
    form.setFieldsValue({
      bystanderEnabled: source?.bystanderEnabled ?? defaults?.bystanderEnabled ?? true,
      proactiveReplyEnabled:
        source?.proactiveReplyEnabled ?? defaults?.proactiveReplyEnabled ?? true,
      cooldownSeconds: source?.cooldownSeconds ?? defaults?.cooldownSeconds ?? 180,
      slidingWindowSize: source?.slidingWindowSize ?? defaults?.slidingWindowSize ?? 20,
      confidenceThreshold:
        source?.confidenceThreshold ?? defaults?.confidenceThreshold ?? 0.82,
      triggerTopics: source?.triggerTopics ?? defaults?.triggerTopics ?? [],
    });
  };

  const save = async (values: PolicyForm) => {
    if (!modal.group) return;
    setSaving(true);
    try {
      await api.updateGroupPolicy(modal.group.conversationId, values);
      message.success('群策略已热更新');
      setModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const muteAll = async () => {
    try {
      const result = await api.emergencyMute();
      message.success(
        `已紧急静音：默认策略${result.muted.length ? ` + ${result.muted.length} 个群` : ''}`,
      );
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="全局默认旁听策略"
        className="console-card"
        extra={
          <Popconfirm
            title="紧急静音全部群聊的旁听与主动回复？"
            onConfirm={() => void muteAll()}
          >
            <Button danger>一键紧急静音</Button>
          </Popconfirm>
        }
      >
        {defaults ? (
          <Descriptions column={3} size="small">
            <Descriptions.Item label="旁听">
              {defaults.bystanderEnabled ? <Tag color="green">开启</Tag> : <Tag>关闭</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="非@主动回复">
              {defaults.proactiveReplyEnabled ? (
                <Tag color="green">开启</Tag>
              ) : (
                <Tag>关闭</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="冷却时间">
              {defaults.cooldownSeconds} 秒
            </Descriptions.Item>
            <Descriptions.Item label="滑动窗口">{defaults.slidingWindowSize}</Descriptions.Item>
            <Descriptions.Item label="置信度阈值">
              {defaults.confidenceThreshold}
            </Descriptions.Item>
            <Descriptions.Item label="触发话题">
              {defaults.triggerTopics.join('、') || '-'}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Alert type="info" message="暂无默认策略数据" />
        )}
      </Card>

      <Card
        title="已接入钉钉群"
        className="console-card"
        extra={<Button onClick={() => void load()}>刷新</Button>}
      >
        <Table<KnownGroup>
          rowKey="conversationId"
          size="small"
          loading={loading}
          dataSource={groups}
          pagination={false}
          columns={[
            { title: '群 ID', dataIndex: 'conversationId' },
            {
              title: '群名称',
              dataIndex: 'title',
              render: (value: string | null) => value ?? '-',
            },
            {
              title: '旁听',
              key: 'bystander',
              render: (_, row) =>
                (row.policy?.bystanderEnabled ?? defaults?.bystanderEnabled) ? (
                  <Tag color="green">开启</Tag>
                ) : (
                  <Tag>关闭</Tag>
                ),
            },
            {
              title: '非@主动回复',
              key: 'proactive',
              render: (_, row) =>
                (row.policy?.proactiveReplyEnabled ?? defaults?.proactiveReplyEnabled) ? (
                  <Tag color="green">开启</Tag>
                ) : (
                  <Tag>关闭</Tag>
                ),
            },
            {
              title: '冷却时间',
              key: 'cooldown',
              render: (_, row) =>
                `${row.policy?.cooldownSeconds ?? defaults?.cooldownSeconds ?? '-'} 秒`,
            },
            {
              title: '最近活跃',
              dataIndex: 'lastActiveAt',
              render: (value: number | null) =>
                value ? new Date(value).toLocaleString() : '-',
            },
            {
              title: '操作',
              key: 'actions',
              render: (_, row) => (
                <Button size="small" onClick={() => openEdit(row)}>
                  配置策略
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={`配置群策略：${modal.group?.title ?? modal.group?.conversationId ?? ''}`}
        open={modal.open}
        confirmLoading={saving}
        onCancel={() => setModal({ open: false })}
        onOk={() => void form.submit()}
        okText="保存并热更新"
      >
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item label="开启旁听" name="bystanderEnabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            label="非@主动回复"
            name="proactiveReplyEnabled"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item label="回复冷却时间（秒）" name="cooldownSeconds">
            <InputNumber min={0} step={30} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="滑动窗口消息数" name="slidingWindowSize">
            <InputNumber min={1} max={200} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="置信度阈值（0-1）" name="confidenceThreshold">
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="触发话题" name="triggerTopics">
            <Select mode="tags" placeholder="输入话题后回车" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
