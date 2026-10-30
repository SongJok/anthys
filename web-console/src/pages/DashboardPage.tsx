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
import type { AuditLog, DashboardPayload, McpServerStatus } from '../types';

const ACTION_LABEL: Record<AuditLog['actionType'], string> = {
  UPDATE_LLM: '更新大模型',
  UPDATE_DINGTALK: '更新钉钉配置',
  RELOAD_MCP: '重载 MCP',
  UPDATE_MCP_POLICY: '更新工具权限',
  UPDATE_GROUP_POLICY: '更新群策略',
  EMERGENCY_MUTE: '紧急静音',
  QUERY_STATS: '查询统计',
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.dashboard());
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
                        {new Date(log.createdAt).toLocaleString()}
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
