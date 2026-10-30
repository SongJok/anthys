import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
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
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api } from '../api';
import type {
  McpAccessPolicy,
  McpDomain,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  McpTransport,
} from '../types';

const DOMAINS: McpDomain[] = ['code', 'data', 'log', 'apidoc', 'business', 'general'];
const TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'streamable-http'];

interface ServerForm {
  id: string;
  name: string;
  domain: McpDomain;
  transport: McpTransport;
  endpointOrCommand: string;
  args: string[];
  envText: string;
  timeoutMs: number;
  maxResultChars: number;
  enabled: boolean;
}

interface PolicyForm {
  id: string;
  conversationId?: string;
  role?: 'admin' | 'employee';
  allowedServerIds: string[];
  allowedTools: string[];
  enabled: boolean;
}

function parseEnv(text: string): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf('=');
      if (index <= 0) throw new Error(`环境变量格式错误：${line}`);
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export default function McpConfigPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [policies, setPolicies] = useState<McpAccessPolicy[]>([]);
  const [loading, setLoading] = useState(false);

  const [serverForm] = Form.useForm<ServerForm>();
  const [serverModal, setServerModal] = useState<{ open: boolean; editing?: McpServerConfig }>({
    open: false,
  });
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const [policyForm] = Form.useForm<PolicyForm>();
  const [policyModal, setPolicyModal] = useState<{ open: boolean; index?: number }>({
    open: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [serverList, policyList] = await Promise.all([
        api.mcpServers(),
        api.accessPolicies(),
      ]);
      setServers(serverList.servers);
      setStatuses(serverList.status);
      setPolicies(policyList.policies);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setServerModal({ open: true });
    serverForm.setFieldsValue({
      id: '',
      name: '',
      domain: 'general',
      transport: 'streamable-http',
      endpointOrCommand: '',
      args: [],
      envText: '',
      timeoutMs: 15000,
      maxResultChars: 8000,
      enabled: true,
    });
  };

  const openEdit = (server: McpServerConfig) => {
    setServerModal({ open: true, editing: server });
    serverForm.setFieldsValue({
      ...server,
      args: server.args ?? [],
      envText: Object.entries(server.envOrHeaders ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    });
  };

  const submitServer = async (values: ServerForm) => {
    let envOrHeaders: Record<string, string> | undefined;
    try {
      envOrHeaders = parseEnv(values.envText ?? '');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return;
    }
    const payload: McpServerConfig = {
      id: values.id.trim(),
      name: values.name?.trim() || values.id.trim(),
      domain: values.domain,
      transport: values.transport,
      endpointOrCommand: values.endpointOrCommand.trim(),
      ...(values.args && values.args.length > 0 ? { args: values.args } : {}),
      ...(envOrHeaders ? { envOrHeaders } : {}),
      timeoutMs: values.timeoutMs,
      maxResultChars: values.maxResultChars,
      enabled: values.enabled,
    };
    try {
      if (serverModal.editing) await api.updateMcp(serverModal.editing.id, payload);
      else await api.createMcp(payload);
      message.success('MCP 节点已保存并热应用到连接池');
      setServerModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleServer = async (server: McpServerConfig, enabled: boolean) => {
    try {
      await api.updateMcp(server.id, { enabled });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const removeServer = async (id: string) => {
    try {
      await api.deleteMcp(id);
      message.success('已删除 MCP 节点');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const runTest = async (server: McpServerConfig) => {
    setTestingId(server.id);
    try {
      const result = await api.testMcp(server.id);
      setTestResult(result.result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTestingId(null);
    }
  };

  const statusOf = (id: string) => statuses.find((item) => item.id === id);

  const openPolicy = (index?: number) => {
    setPolicyModal({ open: true, index });
    if (index !== undefined) {
      policyForm.setFieldsValue(policies[index]);
    } else {
      policyForm.setFieldsValue({
        id: `policy-${policies.length + 1}`,
        role: 'employee',
        allowedServerIds: [],
        allowedTools: [],
        enabled: true,
      });
    }
  };

  const submitPolicy = async (values: PolicyForm) => {
    const next = [...policies];
    const policy: McpAccessPolicy = {
      id: values.id.trim(),
      ...(values.conversationId?.trim()
        ? { conversationId: values.conversationId.trim() }
        : {}),
      ...(values.role ? { role: values.role } : {}),
      allowedServerIds: values.allowedServerIds ?? [],
      allowedTools: values.allowedTools ?? [],
      enabled: values.enabled,
    };
    if (policyModal.index !== undefined) next[policyModal.index] = policy;
    else next.push(policy);
    try {
      const result = await api.updateAccessPolicies(next);
      setPolicies(result.policies);
      message.success('工具调用权限策略已更新');
      setPolicyModal({ open: false });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const removePolicy = async (index: number) => {
    const next = policies.filter((_, item) => item !== index);
    try {
      const result = await api.updateAccessPolicies(next);
      setPolicies(result.policies);
      message.success('策略已删除');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="企业 MCP 节点"
        className="console-card"
        extra={
          <Space>
            <Button onClick={() => void load()}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增节点
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="增删改查后自动热应用到 McpClientPool，无需重启进程；一键测试会实时连接并拉取该节点暴露的全部工具 Schema。"
        />
        <Table<McpServerConfig>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={servers}
          pagination={false}
          columns={[
            { title: 'ID', dataIndex: 'id' },
            { title: '名称', dataIndex: 'name' },
            {
              title: '领域',
              dataIndex: 'domain',
              render: (value: string) => <Tag color="blue">{value}</Tag>,
            },
            { title: '传输', dataIndex: 'transport' },
            {
              title: '地址 / 命令',
              dataIndex: 'endpointOrCommand',
              ellipsis: true,
            },
            {
              title: '状态',
              key: 'status',
              render: (_, row) => {
                const status = statusOf(row.id);
                if (!row.enabled) return <Tag>已禁用</Tag>;
                if (status?.connected) return <Tag color="green">在线 · {status.toolCount} 工具</Tag>;
                return <Tag color="red">{status?.lastError ?? '离线'}</Tag>;
              },
            },
            {
              title: '启用',
              key: 'enabled',
              render: (_, row) => (
                <Switch
                  size="small"
                  checked={row.enabled}
                  onChange={(checked) => void toggleServer(row, checked)}
                />
              ),
            },
            {
              title: '操作',
              key: 'actions',
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" loading={testingId === row.id} onClick={() => void runTest(row)}>
                    测试
                  </Button>
                  <Button size="small" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm title={`删除 ${row.id}？`} onConfirm={() => void removeServer(row.id)}>
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

      <Card
        title="按群 / 角色控制工具调用权限"
        className="console-card"
        extra={
          <Button icon={<PlusOutlined />} onClick={() => openPolicy()}>
            新增策略
          </Button>
        }
      >
        <Table<McpAccessPolicy>
          rowKey="id"
          size="small"
          dataSource={policies}
          pagination={false}
          columns={[
            { title: '策略 ID', dataIndex: 'id' },
            {
              title: '作用域',
              key: 'scope',
              render: (_, row) => (
                <Space>
                  {row.role && <Tag color="purple">{row.role}</Tag>}
                  {row.conversationId && <Tag>群 {row.conversationId}</Tag>}
                  {!row.role && !row.conversationId && <Tag>全局</Tag>}
                </Space>
              ),
            },
            {
              title: '允许的 Server',
              dataIndex: 'allowedServerIds',
              render: (value: string[]) => (value.length ? value.join(', ') : '全部'),
            },
            {
              title: '允许的工具',
              dataIndex: 'allowedTools',
              render: (value: string[]) => (value.length ? value.join(', ') : '全部'),
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              render: (value: boolean) => (value ? <Tag color="green">是</Tag> : <Tag>否</Tag>),
            },
            {
              title: '操作',
              key: 'actions',
              render: (_, row, index) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openPolicy(index)}>
                    编辑
                  </Button>
                  <Button size="small" danger onClick={() => void removePolicy(index)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={serverModal.editing ? `编辑 MCP：${serverModal.editing.id}` : '新增 MCP 节点'}
        open={serverModal.open}
        onCancel={() => setServerModal({ open: false })}
        onOk={() => void serverForm.submit()}
        okText="保存"
        width={640}
      >
        <Form form={serverForm} layout="vertical" onFinish={submitServer}>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item label="ID" name="id" rules={[{ required: true }]} style={{ width: 280 }}>
              <Input disabled={Boolean(serverModal.editing)} placeholder="logs" />
            </Form.Item>
            <Form.Item label="名称" name="name" style={{ width: 280 }}>
              <Input placeholder="日志 MCP" />
            </Form.Item>
          </Space>
          <Space size={12}>
            <Form.Item label="领域" name="domain">
              <Select
                style={{ width: 180 }}
                options={DOMAINS.map((value) => ({ value, label: value }))}
              />
            </Form.Item>
            <Form.Item label="传输方式" name="transport">
              <Select
                style={{ width: 200 }}
                options={TRANSPORTS.map((value) => ({ value, label: value }))}
              />
            </Form.Item>
            <Form.Item label="超时（ms）" name="timeoutMs">
              <InputNumber min={1000} step={1000} />
            </Form.Item>
            <Form.Item label="结果上限字符" name="maxResultChars">
              <InputNumber min={200} step={500} />
            </Form.Item>
          </Space>
          <Form.Item
            label="地址 / 命令"
            name="endpointOrCommand"
            rules={[{ required: true, message: '请输入 MCP 地址或启动命令' }]}
          >
            <Input placeholder="https://mcp.example.com/mcp 或 npx" />
          </Form.Item>
          <Form.Item label="启动参数（仅 stdio）" name="args">
            <Select mode="tags" placeholder="输入参数后回车" />
          </Form.Item>
          <Form.Item label="环境变量 / Headers（每行 KEY=VALUE）" name="envText">
            <Input.TextArea rows={3} placeholder="Authorization=Bearer ${MCP_TOKEN}" />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`连通性测试：${testResult?.serverId ?? ''}`}
        open={Boolean(testResult)}
        footer={null}
        onCancel={() => setTestResult(null)}
        width={720}
      >
        {testResult && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="结果">
                {testResult.ok ? <Tag color="green">连接成功</Tag> : <Tag color="red">失败</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="耗时">{testResult.latencyMs} ms</Descriptions.Item>
            </Descriptions>
            {testResult.error && <Alert type="error" showIcon message={testResult.error} />}
            <Typography.Text strong>发现的工具（{testResult.tools.length}）</Typography.Text>
            <Collapse
              items={testResult.tools.map((tool) => ({
                key: tool.name,
                label: tool.name,
                children: (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary">{tool.description}</Typography.Text>
                    <pre style={{ background: '#f6f8ff', padding: 12, margin: 0, overflow: 'auto' }}>
                      {JSON.stringify(tool.inputSchema, null, 2)}
                    </pre>
                  </Space>
                ),
              }))}
            />
          </Space>
        )}
      </Modal>

      <Modal
        title={policyModal.index !== undefined ? '编辑工具权限策略' : '新增工具权限策略'}
        open={policyModal.open}
        onCancel={() => setPolicyModal({ open: false })}
        onOk={() => void policyForm.submit()}
        okText="保存"
      >
        <Form form={policyForm} layout="vertical" onFinish={submitPolicy}>
          <Form.Item label="策略 ID" name="id" rules={[{ required: true }]}>
            <Input placeholder="dev-group-employee" />
          </Form.Item>
          <Form.Item label="限定群 ID（可选）" name="conversationId">
            <Input placeholder="cidxxxxxx" />
          </Form.Item>
          <Form.Item label="角色（可选）" name="role">
            <Select
              allowClear
              options={[
                { value: 'admin', label: '管理员' },
                { value: 'employee', label: '普通员工' },
              ]}
            />
          </Form.Item>
          <Form.Item label="允许的 Server ID（空表示全部）" name="allowedServerIds">
            <Select mode="tags" placeholder="输入后回车" />
          </Form.Item>
          <Form.Item label="允许的工具名（空表示全部）" name="allowedTools">
            <Select mode="tags" placeholder="mcp__logs__query" />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
