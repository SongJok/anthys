import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
  Button,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  AuditLog,
  DashboardPayload,
  McpServerStatus,
  UsageSummary,
} from '../types';

const ACTION_LABEL: Record<AuditLog['actionType'], string> = {
  UPDATE_LLM: '更新大模型',
  UPDATE_DINGTALK: '更新钉钉配置',
  RELOAD_MCP: '重载 MCP',
  UPDATE_MCP_POLICY: '更新工具权限',
  UPDATE_GROUP_POLICY: '更新群策略',
  EMERGENCY_MUTE: '紧急静音',
  UPDATE_SCHEDULES: '更新定时任务',
  UPDATE_RETENTION: '更新保留策略',
  PURGE_DATA: '清理过期数据',
  DELETE_USER_DATA: '删除用户数据',
  UPDATE_GLOSSARY: '更新术语库',
  QUERY_STATS: '查询统计',
  UPDATE_EXTENSIONS: '更新扩展开关',
  UPDATE_SKILL: '更新技能',
  RELOAD_SKILLS: '重载技能',
  INSTALL_PLUGIN: '安装插件',
  ENABLE_PLUGIN: '启用插件',
  DISABLE_PLUGIN: '停用插件',
  UPGRADE_PLUGIN: '升级插件',
  ROLLBACK_PLUGIN: '回滚插件',
  UNINSTALL_PLUGIN: '卸载插件',
  CREATE_PROJECT: '登记项目',
  UPDATE_PROJECT: '更新项目',
  SYNC_PROJECT: '同步项目',
  DELETE_PROJECT: '删除项目',
  GENERATE_PROJECT_HANDBOOK: '生成手册草稿',
  UPDATE_PROJECT_HANDBOOK: '保存手册草稿',
  PUBLISH_PROJECT_HANDBOOK: '发布项目手册',
  UPDATE_PROJECT_MANUAL: '维护人工条目',
  TEST_GITHUB: '测试 GitHub',
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, usagePayload] = await Promise.all([
        api.dashboard(),
        api.usage(1),
      ]);
      setData(dashboard);
      setUsage(usagePayload.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = data?.mcpServers.filter((item) => item.connected).length ?? 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}
      <Row gutter={16}>
        <Col span={6}>
          <Card loading={loading} className="console-card">
            <Statistic
              title="Stream 连接"
              value={data?.stream?.connected ? '在线' : '离线'}
              valueStyle={{ color: data?.stream?.connected ? '#16a34a' : '#dc2626' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card loading={loading} className="console-card">
            <Statistic title="今日对话轮次" value={data?.today.totalTurns ?? 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card loading={loading} className="console-card">
            <Statistic title="今日 Token 消耗" value={data?.today.totalTokens ?? 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card loading={loading} className="console-card">
            <Statistic
              title="MCP 在线节点"
              value={`${connected} / ${data?.mcpServers.length ?? 0}`}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="MCP 节点健康状态"
        className="console-card"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      >
        <Table<McpServerStatus>
          size="small"
          rowKey="id"
          loading={loading}
          pagination={false}
          dataSource={data?.mcpServers ?? []}
          columns={[
            { title: 'ID', dataIndex: 'id' },
            { title: '名称', dataIndex: 'name' },
            {
              title: '状态',
              dataIndex: 'connected',
              render: (value: boolean, row) =>
                !row.enabled ? (
                  <Tag>已禁用</Tag>
                ) : value ? (
                  <Tag color="green">在线</Tag>
                ) : (
                  <Tag color="red">离线</Tag>
                ),
            },
            { title: '工具数', dataIndex: 'toolCount' },
            {
              title: '最近错误',
              dataIndex: 'lastError',
              render: (value: string | null) =>
                value ? <Typography.Text type="danger">{value}</Typography.Text> : '-',
            },
          ]}
        />
      </Card>

      <Card
        title="今日 Token 与成本归因"
        className="console-card"
        extra={<Typography.Text type="secondary">成本按部署配置的模型单价估算，单位人民币</Typography.Text>}
      >
        <Space size={40} wrap style={{ marginBottom: 16 }}>
          <Statistic title="输入 Token" value={usage?.totalInputTokens ?? 0} />
          <Statistic title="输出 Token" value={usage?.totalOutputTokens ?? 0} />
          <Statistic
            title="估算成本"
            value={`¥${((usage?.totalCostMicros ?? 0) / 1_000_000).toFixed(4)}`}
          />
          <Statistic
            title="已定价轮次"
            value={`${usage?.pricedTurns ?? 0} / ${usage?.totalTurns ?? 0}`}
          />
        </Space>
        {(usage?.totalTurns ?? 0) > 0 && (usage?.pricedTurns ?? 0) === 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="尚未配置 MODEL_PRICING_JSON，当前只统计 Token，成本不做展示口径"
          />
        )}
        <Table
          size="small"
          rowKey={(row) => `${row.group}:${row.key}`}
          pagination={false}
          loading={loading}
          dataSource={[
            ...(usage?.byModel ?? []).map((row) => ({ ...row, group: '模型' })),
            ...(usage?.byWorker ?? []).map((row) => ({ ...row, group: 'Worker' })),
          ]}
          columns={[
            { title: '类型', dataIndex: 'group', width: 90 },
            { title: '模型 / Worker', dataIndex: 'label' },
            { title: '轮次', dataIndex: 'turns' },
            { title: 'Token', dataIndex: 'tokens' },
            {
              title: '估算成本',
              dataIndex: 'costMicros',
              render: (value: number) => `¥${(value / 1_000_000).toFixed(4)}`,
            },
          ]}
        />
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card title="各群旁听触发统计" className="console-card">
            <Table
              size="small"
              rowKey="conversationId"
              pagination={false}
              dataSource={data?.today.byGroup ?? []}
              columns={[
                { title: '群 ID', dataIndex: 'conversationId' },
                { title: '对话轮次', dataIndex: 'turns' },
                { title: '主动回复', dataIndex: 'proactiveReplies' },
                { title: 'Token', dataIndex: 'totalTokens' },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="最近管理操作审计" className="console-card">
            <Timeline
              items={(data?.auditLogs ?? []).map((log) => ({
                color: 'blue',
                children: (
                  <div>
                    <Space size={8}>
                      <Tag color="geekblue">{ACTION_LABEL[log.actionType]}</Tag>
                      <Typography.Text strong>
                        {log.adminNick || log.adminStaffId}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {formatShanghaiDateTime(log.createdAt)}
                      </Typography.Text>
                    </Space>
                  </div>
                ),
              }))}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
