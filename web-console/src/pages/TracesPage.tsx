import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Collapse,
  Descriptions,
  Input,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { api } from '../api';
import type { ReActTrace, ReActTraceStep, TracePage } from '../types';

const STEP_LABEL: Record<ReActTraceStep['type'], string> = {
  reasoning: '原生思维链',
  tool: 'MCP 工具调用',
  sandbox: '沙盒执行',
  answer: '最终回答',
};

const STEP_COLOR: Record<ReActTraceStep['type'], string> = {
  reasoning: 'geekblue',
  tool: 'blue',
  sandbox: 'purple',
  answer: 'green',
};

function renderStep(step: ReActTraceStep) {
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space size={8}>
        <Tag color={STEP_COLOR[step.type]}>{STEP_LABEL[step.type]}</Tag>
        {step.toolName && <Typography.Text code>{step.toolName}</Typography.Text>}
        {step.durationMs !== undefined && (
          <Tag>{step.durationMs} ms</Tag>
        )}
        {step.isError && <Tag color="red">失败</Tag>}
      </Space>
      {step.arguments && (
        <pre style={{ background: '#f6f8ff', padding: 10, margin: 0, overflow: 'auto' }}>
          {JSON.stringify(step.arguments, null, 2)}
        </pre>
      )}
      {step.content && (
        <div className={step.type === 'reasoning' ? 'trace-reasoning' : undefined}>
          {step.content}
        </div>
      )}
      {step.output && (
        <Typography.Paragraph ellipsis={{ rows: 4, expandable: true }}>
          {step.output}
        </Typography.Paragraph>
      )}
    </Space>
  );
}

export default function TracesPage() {
  const [data, setData] = useState<TracePage>({ items: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.traces({
        page,
        pageSize,
        ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
      });
      setData(result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card title="ReAct 全链路轨迹" className="console-card">
      <Space style={{ marginBottom: 16 }}>
        <Input
          placeholder="按群 / 会话 ID 过滤"
          value={conversationId}
          onChange={(event) => {
            setConversationId(event.target.value);
            setPage(1);
          }}
          style={{ width: 260 }}
          allowClear
        />
        <Button onClick={() => void load()}>刷新</Button>
      </Space>
      <Table<ReActTrace>
        rowKey="id"
        loading={loading}
        dataSource={data.items}
        pagination={{
          current: page,
          pageSize,
          total: data.total,
          showSizeChanger: true,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
        expandable={{
          expandedRowRender: (record) => (
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="Token">{record.totalTokens}</Descriptions.Item>
                <Descriptions.Item label="步骤">{record.stepCount}</Descriptions.Item>
                <Descriptions.Item label="耗时">{record.durationMs} ms</Descriptions.Item>
                <Descriptions.Item label="耗时">
                  {new Date(record.createdAt).toLocaleString()}
                </Descriptions.Item>
              </Descriptions>
              <Collapse
                defaultActiveKey={record.steps.map((step) => String(step.index))}
                items={record.steps.map((step) => ({
                  key: String(step.index),
                  label: `${step.index + 1}. ${STEP_LABEL[step.type]}${
                    step.toolName ? ` · ${step.toolName}` : ''
                  }`,
                  children: renderStep(step),
                }))}
              />
            </Space>
          ),
        }}
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            render: (value: string) => new Date(value).toLocaleString(),
            width: 180,
          },
          { title: '会话', dataIndex: 'conversationId', ellipsis: true },
          {
            title: '类型',
            dataIndex: 'conversationType',
            width: 90,
            render: (value: string) => (value === '1' ? <Tag>单聊</Tag> : <Tag>群聊</Tag>),
          },
          {
            title: '主动回复',
            dataIndex: 'proactive',
            width: 100,
            render: (value: boolean) =>
              value ? <Tag color="orange">是</Tag> : <Tag>否</Tag>,
          },
          { title: '问题', dataIndex: 'question', ellipsis: true },
          {
            title: '工具步骤',
            key: 'tools',
            width: 100,
            render: (_, row) =>
              row.steps.filter((step) => step.type === 'tool' || step.type === 'sandbox').length,
          },
          { title: 'Token', dataIndex: 'totalTokens', width: 90 },
          { title: '耗时(ms)', dataIndex: 'durationMs', width: 100 },
        ]}
      />
    </Card>
  );
}
