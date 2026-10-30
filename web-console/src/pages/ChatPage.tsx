import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { api, chatStreamUrl } from '../api';
import type { ChatToolCall, ChatTurnUsage } from '../types';

interface StreamEvent {
  type: string;
  content?: string;
  narration?: string;
  message?: string;
  toolName?: string;
  summary?: string;
  isError?: boolean;
  durationMs?: number;
  stopped?: boolean;
  usage?: ChatTurnUsage;
}

const TOOL_TAG_COLOR: Record<ChatToolCall['status'], string> = {
  running: 'processing',
  done: 'green',
  failed: 'red',
};

export default function ChatPage() {
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [reasoning, setReasoning] = useState('');
  const [narration, setNarration] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState('');
  const [tools, setTools] = useState<ChatToolCall[]>([]);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<ChatTurnUsage | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const dispose = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => dispose, [dispose]);

  const reset = () => {
    setReasoning('');
    setNarration('');
    setAnswer('');
    setStatus('');
    setTools([]);
    setError('');
    setUsage(null);
  };

  const finish = () => {
    dispose();
    setRunning(false);
    setStatus('');
  };

  const ask = async () => {
    const text = question.trim();
    if (!text || running) return;
    reset();
    setRunning(true);
    let ticket: string;
    try {
      ticket = (await api.createChatTicket()).ticket;
    } catch (err) {
      setRunning(false);
      message.error(err instanceof Error ? err.message : String(err));
      return;
    }

    const source = new EventSource(chatStreamUrl(ticket, text));
    sourceRef.current = source;

    const on = (name: string, handler: (event: StreamEvent) => void) => {
      source.addEventListener(name, (raw) => {
        try {
          handler(JSON.parse((raw as MessageEvent<string>).data) as StreamEvent);
        } catch {
          // 忽略无法解析的心跳/脏帧
        }
      });
    };

    on('turn_start', () => setStatus('模型推理中…'));
    on('reasoning_delta', (event) =>
      setReasoning((prev) => prev + (event.content ?? '')),
    );
    on('narration_delta', (event) =>
      setNarration((prev) => prev + (event.content ?? '')),
    );
    on('answer_delta', (event) =>
      setAnswer((prev) => prev + (event.content ?? '')),
    );
    on('answer_reset', (event) => {
      const moved = event.narration ?? '';
      if (moved) setNarration(moved);
      setAnswer('');
    });
    on('status', (event) => setStatus(event.message ?? ''));
    on('tool_start', (event) => {
      setTools((prev) => [
        ...prev,
        {
          id: `${event.toolName}-${prev.length}`,
          name: event.toolName ?? 'tool',
          status: 'running',
        },
      ]);
    });
    on('tool_progress', (event) => {
      setTools((prev) =>
        prev.map((tool, index) =>
          index === prev.length - 1 && tool.status === 'running'
            ? { ...tool, detail: event.message }
            : tool,
        ),
      );
    });
    on('tool_end', (event) => {
      setTools((prev) =>
        prev.map((tool, index) =>
          index === prev.length - 1 && tool.status === 'running'
            ? {
                ...tool,
                status: event.isError ? 'failed' : 'done',
                detail: event.summary,
                durationMs: event.durationMs,
              }
            : tool,
        ),
      );
    });
    on('completed', (event) => {
      if (event.usage) setUsage(event.usage);
    });
    on('error', (event) => {
      setError(event.message ?? '生成失败');
    });
    on('done', finish);
    source.onerror = () => {
      // 服务端正常结束时也会触发 onerror，交给 done 事件收尾
      if (source.readyState === EventSource.CLOSED) finish();
    };
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="在线对话（SSE 流式）" size="small">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          使用一次性票据订阅服务端流式输出，与钉钉卡片共享同一套 ReAct 与工具链路。
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={question}
          placeholder="输入问题后回车或点击发送"
          onChange={(event) => setQuestion(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
          disabled={running}
        />
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" loading={running} onClick={() => void ask()}>
            发送
          </Button>
          <Button
            disabled={!running}
            onClick={() => {
              finish();
              setStatus('已断开生成');
            }}
          >
            停止
          </Button>
          <Typography.Text type="secondary">{status}</Typography.Text>
        </Space>
      </Card>

      {error && <Alert type="error" showIcon message={error} />}

      <Card
        title="回答"
        size="small"
        extra={
          usage && (
            <Space size={4}>
              <Tag>{usage.totalTokens} tokens</Tag>
              <Tag>{usage.steps} 步</Tag>
              <Tag>{usage.durationMs} ms</Tag>
              {usage.stopped && <Tag color="orange">已停止</Tag>}
            </Space>
          )
        }
      >
        {answer ? (
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
            {answer}
          </Typography.Paragraph>
        ) : (
          <Empty description={running ? '等待模型输出…' : '尚未发起对话'} />
        )}
      </Card>

      {(reasoning || narration) && (
        <Card title="推理过程" size="small">
          {(narration || reasoning)
            .split('\n')
            .filter(Boolean)
            .map((line, index) => (
              <Typography.Paragraph
                key={`${index}-${line.slice(0, 8)}`}
                type="secondary"
                style={{ marginBottom: 6 }}
              >
                {line}
              </Typography.Paragraph>
            ))}
        </Card>
      )}

      {tools.length > 0 && (
        <Card title="工具调用" size="small">
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {tools.map((tool) => (
              <Space key={tool.id} size={8} wrap>
                <Tag color={TOOL_TAG_COLOR[tool.status]}>{tool.status}</Tag>
                <Typography.Text code>{tool.name}</Typography.Text>
                {tool.durationMs !== undefined && <Tag>{tool.durationMs} ms</Tag>}
                {tool.detail && (
                  <Typography.Text type="secondary" ellipsis>
                    {tool.detail}
                  </Typography.Text>
                )}
              </Space>
            ))}
          </Space>
        </Card>
      )}
    </Space>
  );
}
