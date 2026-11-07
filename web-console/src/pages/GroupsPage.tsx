import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
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
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  DefaultGroupPolicy,
  GroupDirectoryEntry,
  GroupModelProvider,
  GroupPolicy,
  KnownGroup,
} from '../types';

interface ModelRouteForm {
  enabled: boolean;
  provider: GroupModelProvider;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  temperature: number | null;
  thinking: 'off' | 'auto' | 'low' | 'high' | 'max' | '';
  maxTokens: number | null;
}

interface PolicyForm {
  bystanderEnabled: boolean;
  proactiveReplyEnabled: boolean;
  silentInvestigationEnabled: boolean;
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

  const [modelModal, setModelModal] = useState<{
    open: boolean;
    group?: KnownGroup;
    exists?: boolean;
    apiKeyConfigured?: boolean;
    updatedAt?: number;
  }>({ open: false });
  const [modelSaving, setModelSaving] = useState(false);
  const [modelForm] = Form.useForm<ModelRouteForm>();
  const [directoryItems, setDirectoryItems] = useState<GroupDirectoryEntry[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [syncingDirectory, setSyncingDirectory] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [onlyWithBots, setOnlyWithBots] = useState(true);

  const loadDirectory = useCallback(
    async (query = directoryQuery, withBots = onlyWithBots) => {
      setDirectoryLoading(true);
      try {
        const res = await api.groupDirectory({
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(withBots ? { onlyWithBots: true } : {}),
          limit: 500,
        });
        setDirectoryItems(res.items);
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setDirectoryLoading(false);
      }
    },
    [directoryQuery, onlyWithBots],
  );

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
    void loadDirectory();
  }, [load, loadDirectory]);

  const handleSyncDirectory = async () => {
    setSyncingDirectory(true);
    try {
      const { result } = await api.syncGroupDirectory(true);
      message.success(
        `群与机器人目录已同步至数据库：共 ${result.total} 个群（含机器人 ${result.withBots} 个，新增 ${result.created}，更新 ${result.updated}）`,
      );
      await Promise.all([load(), loadDirectory()]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncingDirectory(false);
    }
  };

  const openEdit = (group: KnownGroup) => {
    const source: GroupPolicy | undefined = group.policy;
    setModal({ open: true, group });
    form.setFieldsValue({
      bystanderEnabled: source?.bystanderEnabled ?? defaults?.bystanderEnabled ?? true,
      proactiveReplyEnabled:
        source?.proactiveReplyEnabled ?? defaults?.proactiveReplyEnabled ?? true,
      silentInvestigationEnabled:
        source?.silentInvestigationEnabled ??
        defaults?.silentInvestigationEnabled ??
        true,
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

  const openModelRoute = async (group: KnownGroup) => {
    try {
      const result = await api.groupModelRoute(group.conversationId);
      const route = result.route;
      modelForm.setFieldsValue({
        enabled: route?.enabled ?? true,
        provider: route?.provider ?? '',
        baseUrl: route?.baseUrl ?? '',
        apiKeyEnv: route?.apiKeyEnv ?? '',
        model: route?.model ?? '',
        temperature: route?.temperature ?? null,
        thinking: route?.thinking ?? '',
        maxTokens: route?.maxTokens ?? null,
      });
      setModelModal({
        open: true,
        group,
        exists: Boolean(route),
        apiKeyConfigured: result.apiKeyConfigured ?? false,
        ...(route ? { updatedAt: route.updatedAt } : {}),
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const saveModelRoute = async (values: ModelRouteForm) => {
    if (!modelModal.group) return;
    setModelSaving(true);
    try {
      const result = await api.updateGroupModelRoute(
        modelModal.group.conversationId,
        {
          enabled: values.enabled,
          provider: values.provider ?? '',
          baseUrl: values.baseUrl ?? '',
          apiKeyEnv: values.apiKeyEnv ?? '',
          model: values.model ?? '',
          temperature:
            values.temperature === undefined ? null : values.temperature,
          thinking: values.thinking ?? '',
          maxTokens: values.maxTokens === undefined ? null : values.maxTokens,
        },
      );
      message.success(
        result.apiKeyConfigured || !result.route.apiKeyEnv
          ? '群模型路由已保存，下一条消息立即生效'
          : `路由已保存，但环境变量 ${result.route.apiKeyEnv} 未配置，调用会失败`,
      );
      setModelModal((prev) => ({
        ...prev,
        exists: true,
        apiKeyConfigured: result.apiKeyConfigured,
      }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setModelSaving(false);
    }
  };

  const removeModelRoute = async () => {
    if (!modelModal.group) return;
    setModelSaving(true);
    try {
      await api.deleteGroupModelRoute(modelModal.group.conversationId);
      message.success('已删除群模型路由，该群回落到默认模型');
      setModelModal({ open: false });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setModelSaving(false);
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
            <Descriptions.Item label="静默调查">
              {defaults.silentInvestigationEnabled ? (
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
              title: '群内机器人',
              key: 'bots',
              render: (_, row) =>
                row.bots && row.bots.length > 0 ? (
                  <Space size={[4, 4]} wrap>
                    {row.bots.map((bot) => (
                      <Tag key={`${bot.openBotId}:${bot.name}`}>{bot.name}</Tag>
                    ))}
                  </Space>
                ) : (
                  '-'
                ),
            },
            {
              title: '旁听',
              key: 'bystander',
              render: (_, row) => {
                const enabled =
                  row.policy?.bystanderEnabled ?? defaults?.bystanderEnabled ?? false;
                const listening = row.listening === true;
                if (enabled && listening) {
                  return (
                    <Tooltip title="已订阅长连接，群内非 @ 消息会进入旁听判定">
                      <Tag color="green">生效</Tag>
                    </Tooltip>
                  );
                }
                if (enabled && !listening) {
                  return (
                    <Tooltip title="策略显示开启（全局默认或群配置），但该群未订阅长连接，收不到非 @ 消息。在「配置策略」里保存一次并保持开启即可订阅">
                      <Tag color="orange">未订阅</Tag>
                    </Tooltip>
                  );
                }
                if (!enabled && listening) {
                  return (
                    <Tooltip title="该群由 BYSTANDER_LISTEN_GROUPS 订阅，但群策略关闭了旁听，非 @ 消息会被判定丢弃">
                      <Tag color="blue">策略关闭</Tag>
                    </Tooltip>
                  );
                }
                return <Tag>关闭</Tag>;
              },
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
              title: '静默调查',
              key: 'investigation',
              render: (_, row) =>
                (row.policy?.silentInvestigationEnabled ??
                defaults?.silentInvestigationEnabled) ? (
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
                value ? formatShanghaiDateTime(value) : '-',
            },
            {
              title: '操作',
              key: 'actions',
              width: 200,
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(row)}>
                    配置策略
                  </Button>
                  <Button size="small" onClick={() => void openModelRoute(row)}>
                    模型路由
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="组织群与机器人目录（数据库）"
        className="console-card"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="按群名、群 ID 或机器人名筛选"
              value={directoryQuery}
              onChange={(e) => setDirectoryQuery(e.target.value)}
              onSearch={(val) => void loadDirectory(val, onlyWithBots)}
              style={{ width: 240 }}
            />
            <Space size={4}>
              <Switch
                size="small"
                checked={onlyWithBots}
                onChange={(checked) => {
                  setOnlyWithBots(checked);
                  void loadDirectory(directoryQuery, checked);
                }}
              />
              <Typography.Text type="secondary">仅含机器人</Typography.Text>
            </Space>
            <Button
              loading={syncingDirectory}
              onClick={() => void handleSyncDirectory()}
            >
              从 DWS 同步群与机器人
            </Button>
          </Space>
        }
      >
        <Table<GroupDirectoryEntry>
          rowKey="conversationId"
          size="small"
          loading={directoryLoading}
          dataSource={directoryItems}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          columns={[
            { title: '群名称', dataIndex: 'name', width: 220 },
            { title: '群 ID', dataIndex: 'conversationId', ellipsis: true },
            {
              title: '已装机器人',
              key: 'bots',
              render: (_, row) =>
                row.bots.length > 0 ? (
                  <Space size={[4, 4]} wrap>
                    {row.bots.map((bot) => (
                      <Tag key={`${bot.openBotId}:${bot.name}`}>{bot.name}</Tag>
                    ))}
                  </Space>
                ) : (
                  '-'
                ),
            },
            {
              title: '同步时间',
              dataIndex: 'syncedAt',
              width: 170,
              render: (value: string) => formatShanghaiDateTime(value),
            },
            {
              title: '操作',
              key: 'actions',
              width: 120,
              render: (_, row) => (
                <Button
                  size="small"
                  onClick={() => {
                    const existing = groups.find(
                      (g) => g.conversationId === row.conversationId,
                    );
                    openEdit(
                      existing ?? {
                        conversationId: row.conversationId,
                        title: row.name || null,
                        conversationType: '2',
                        bystanderEnabled: null,
                        proactiveReplyEnabled: null,
                        lastActiveAt: null,
                        bots: row.bots,
                        botCount: row.botCount,
                      },
                    );
                  }}
                >
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
        {modal.group && modal.group.listening !== true ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="该群尚未订阅旁听长连接"
            description="全局默认只提供判定参数；把「开启旁听」保存为开启后，该群才会加入监听白名单并立即生效。"
          />
        ) : null}
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
          <Form.Item
            label="静默只读调查"
            name="silentInvestigationEnabled"
            valuePropName="checked"
            extra="对未触发主动回复的可疑消息做只读查证，证据达标才浮出；关闭可省下模型预算。"
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

      <Modal
        title={`群模型路由：${modelModal.group?.title ?? modelModal.group?.conversationId ?? ''}`}
        open={modelModal.open}
        confirmLoading={modelSaving}
        onCancel={() => setModelModal({ open: false })}
        onOk={() => void modelForm.submit()}
        okText="保存并生效"
        width={640}
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space>
            {modelModal.exists ? (
              <Popconfirm
                title="删除该群模型路由？"
                description="删除后该群回落到默认模型。"
                onConfirm={() => void removeModelRoute()}
              >
                <Button danger loading={modelSaving}>
                  删除路由
                </Button>
              </Popconfirm>
            ) : null}
            <CancelBtn />
            <OkBtn />
          </Space>
        )}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="群模型路由只对群聊生效（含该群的主动回复），单聊仍走默认角色模型。留空字段沿用默认模型配置；API Key 只填环境变量名，密钥留在部署环境。"
        />
        {modelModal.group ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            会话：{modelModal.group.conversationId}
            {modelModal.updatedAt
              ? ` · 最后更新 ${formatShanghaiDateTime(modelModal.updatedAt)}`
              : ''}
            {modelModal.exists && modelModal.apiKeyConfigured === false
              ? ' · 当前环境变量未配置'
              : ''}
          </Typography.Paragraph>
        ) : null}
        <Form form={modelForm} layout="vertical" onFinish={saveModelRoute}>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            label="供应商"
            name="provider"
            extra="留空沿用默认供应商；anthropic 走 Anthropic 协议。"
          >
            <Select
              options={[
                { value: '', label: '沿用默认' },
                { value: 'openai-compatible', label: 'OpenAI 兼容' },
                { value: 'anthropic', label: 'Anthropic' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="模型名"
            name="model"
            rules={[{ required: true, message: '群路由必须显式指定模型' }]}
          >
            <Input placeholder="例如 gpt-4o-mini / qwen-max" />
          </Form.Item>
          <Form.Item
            label="Base URL"
            name="baseUrl"
            extra="留空沿用默认地址；填写后需带 http(s)://。"
          >
            <Input placeholder="https://api.example.com/v1" />
          </Form.Item>
          <Form.Item
            label="API Key 环境变量名"
            name="apiKeyEnv"
            extra="例如 GROUP_A_MODEL_KEY；留空沿用默认模型的密钥。"
          >
            <Input placeholder="GROUP_A_MODEL_KEY" />
          </Form.Item>
          <Form.Item label="温度（0-2，留空沿用默认）" name="temperature">
            <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="思维链" name="thinking">
            <Select
              options={[
                { value: '', label: '沿用默认' },
                { value: 'off', label: 'off' },
                { value: 'auto', label: 'auto' },
                { value: 'low', label: 'low' },
                { value: 'high', label: 'high' },
                { value: 'max', label: 'max' },
              ]}
            />
          </Form.Item>
          <Form.Item label="最大输出 tokens（留空沿用默认）" name="maxTokens">
            <InputNumber min={1} max={200000} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
