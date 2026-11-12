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
  Radio,
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
  ScheduledTask,
  ScheduledTaskKind,
  SystemLoopStatus,
} from '../types';

const KIND_META: Record<ScheduledTaskKind, { label: string; color: string }> = {
  prompt: { label: '定时播报', color: 'blue' },
  reminder: { label: '个人提醒', color: 'cyan' },
  daily_report: { label: '日报', color: 'green' },
  weekly_report: { label: '周报', color: 'green' },
  monthly_report: { label: '月报', color: 'green' },
  group_report: { label: '群播报', color: 'purple' },
};

const KIND_OPTIONS = (Object.keys(KIND_META) as ScheduledTaskKind[]).map(
  (kind) => ({ value: kind, label: KIND_META[kind].label }),
);

interface TaskForm {
  kind: ScheduledTaskKind;
  title: string;
  conversationType: '1' | '2';
  conversationId: string;
  prompt: string;
  scheduleType: 'cron' | 'interval';
  cron: string;
  intervalSeconds: number;
  enabled: boolean;
  createdBy: string;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('zh-CN', { hour12: false });
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.cron) return `cron ${task.cron}`;
  if (task.intervalSeconds) {
    const seconds = task.intervalSeconds;
    if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
    if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
    return `每 ${seconds} 秒`;
  }
  return '一次性';
}

export default function ScheduledTasksPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loops, setLoops] = useState<SystemLoopStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ open: boolean; editing?: ScheduledTask }>({
    open: false,
  });
  const [form] = Form.useForm<TaskForm>();
  const scheduleType = Form.useWatch('scheduleType', form);
  const kind = Form.useWatch('kind', form);
  const editing = Boolean(modal.editing);
  const promptRequired = kind === 'prompt' || kind === 'reminder';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [taskList, loopList] = await Promise.all([
        api.scheduledTasks(),
        api.systemLoops(),
      ]);
      setTasks(taskList.tasks);
      setLoops(loopList.loops);
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
    setModal({ open: true });
    form.setFieldsValue({
      kind: 'prompt',
      title: '',
      conversationType: '2',
      conversationId: '',
      prompt: '',
      scheduleType: 'interval',
      cron: '0 9 * * *',
      intervalSeconds: 3600,
      enabled: true,
      createdBy: '',
    });
  };

  const openEdit = (task: ScheduledTask) => {
    setModal({ open: true, editing: task });
    form.setFieldsValue({
      kind: task.kind,
      title: task.title,
      conversationType: task.conversationType,
      conversationId: task.conversationId,
      prompt: task.prompt,
      scheduleType: task.cron ? 'cron' : 'interval',
      cron: task.cron ?? '0 9 * * *',
      intervalSeconds: task.intervalSeconds ?? 3600,
      enabled: task.enabled,
      createdBy: task.createdBy,
    });
  };

  const submit = async (values: TaskForm) => {
    const schedule =
      values.scheduleType === 'cron'
        ? { cron: values.cron?.trim() || null, intervalSeconds: null }
        : { cron: null, intervalSeconds: values.intervalSeconds };
    if (values.scheduleType === 'cron' && !schedule.cron) {
      message.error('请填写 cron 表达式');
      return;
    }
    try {
      if (modal.editing) {
        await api.updateScheduledTask(modal.editing.id, {
          title: values.title?.trim() ?? '',
          prompt: values.prompt?.trim() ?? '',
          enabled: values.enabled,
          ...schedule,
        });
      } else {
        await api.createScheduledTask({
          kind: values.kind,
          title: values.title?.trim() || '定时播报',
          conversationType: values.conversationType,
          conversationId: values.conversationId.trim(),
          prompt: values.prompt?.trim() ?? '',
          enabled: values.enabled,
          ...(values.createdBy?.trim() ? { createdBy: values.createdBy.trim() } : {}),
          ...schedule,
        });
      }
      message.success('定时任务已保存');
      setModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    try {
      await api.updateScheduledTask(task.id, { enabled });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setRunningId(task.id);
    try {
      await api.runScheduledTask(task.id);
      message.success('已触发立即执行');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningId(null);
    }
  };

  const remove = async (task: ScheduledTask) => {
    try {
      await api.deleteScheduledTask(task.id);
      message.success('定时任务已删除');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="用户定时任务"
        className="console-card"
        extra={
          <Space>
            <Button onClick={() => void load()}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增任务
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="统一管理全部用户定时任务：个人提醒、日报 / 周报 / 月报、群播报与定时 prompt。"
          description="可在此查看、新建、编辑调度、启停、立即执行与删除；「立即执行」会真实向目标会话推送消息。提醒与报告通常由本人在单聊中创建，管理端可统一治理。"
        />
        <Table<ScheduledTask>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={tasks}
          pagination={false}
          scroll={{ x: 1100 }}
          columns={[
            { title: '标题', dataIndex: 'title', ellipsis: true },
            {
              title: '种类',
              dataIndex: 'kind',
              render: (value: ScheduledTaskKind) => (
                <Tag color={KIND_META[value]?.color}>{KIND_META[value]?.label ?? value}</Tag>
              ),
            },
            {
              title: '会话',
              key: 'conversation',
              render: (_, row) => (
                <Space size={4}>
                  <Tag>{row.conversationType === '1' ? '单聊' : '群聊'}</Tag>
                  <Typography.Text copyable={{ text: row.conversationId }} style={{ maxWidth: 160 }} ellipsis>
                    {row.conversationId}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '调度',
              key: 'schedule',
              render: (_, row) => scheduleLabel(row),
            },
            {
              title: '启用',
              key: 'enabled',
              render: (_, row) => (
                <Switch
                  size="small"
                  checked={row.enabled}
                  onChange={(checked) => void toggle(row, checked)}
                />
              ),
            },
            {
              title: '上次运行',
              dataIndex: 'lastRunAt',
              render: (value: string | null) => formatTime(value),
            },
            {
              title: '下次运行',
              dataIndex: 'nextRunAt',
              render: (value: string | null) => formatTime(value),
            },
            { title: '创建者', dataIndex: 'createdBy', ellipsis: true },
            {
              title: '操作',
              key: 'actions',
              fixed: 'right',
              render: (_, row) => (
                <Space size={4}>
                  <Popconfirm
                    title="立即执行会向目标会话真实推送消息，确认？"
                    onConfirm={() => void runNow(row)}
                  >
                    <Button size="small" loading={runningId === row.id}>
                      立即执行
                    </Button>
                  </Popconfirm>
                  <Button size="small" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm title={`删除「${row.title || row.id}」？`} onConfirm={() => void remove(row)}>
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

      <Card title="系统级周期循环（只读）" className="console-card">
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="以下为基础设施定时器，由环境变量 / 内置默认驱动，不属于用户定时任务，管理端仅展示状态，不可在此启停。"
          description="标注「仅主实例」的循环只在持有 Stream 主锁的实例运行；周期来源为 env 变量名时，需修改进程环境变量并重启才能调整。"
        />
        <Table<SystemLoopStatus>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={loops}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '用途', dataIndex: 'purpose', ellipsis: true },
            { title: '周期', dataIndex: 'intervalLabel' },
            {
              title: '来源',
              dataIndex: 'source',
              render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
            },
            {
              title: '状态',
              key: 'running',
              render: (_, row) => (
                <Space size={4}>
                  <Tag color={row.running ? 'green' : 'default'}>
                    {row.running ? '运行中' : '未运行'}
                  </Tag>
                  {row.leaderGated && <Tag color="orange">仅主实例</Tag>}
                </Space>
              ),
            },
            { title: '备注', dataIndex: 'notes', ellipsis: true, render: (value?: string) => value ?? '—' },
          ]}
        />
      </Card>

      <Modal
        title={editing ? '编辑定时任务' : '新增定时任务'}
        open={modal.open}
        onCancel={() => setModal({ open: false })}
        onOk={() => form.submit()}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={submit} preserve={false}>
          <Form.Item name="kind" label="种类" rules={[{ required: true }]}>
            <Select options={KIND_OPTIONS} disabled={editing} />
          </Form.Item>
          <Form.Item name="title" label="标题">
            <Input placeholder="例如：每日巡检播报" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="conversationType" label="会话类型" style={{ flex: 1 }}>
              <Select
                disabled={editing}
                options={[
                  { value: '2', label: '群聊' },
                  { value: '1', label: '单聊' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="conversationId"
              label="会话 ID"
              style={{ flex: 2 }}
              rules={[{ required: true, message: '请填写会话 ID（群 conversationId 或本人 staffId）' }]}
            >
              <Input placeholder="群 conversationId 或用户 staffId" disabled={editing} />
            </Form.Item>
          </Space>
          <Form.Item
            name="prompt"
            label={promptRequired ? '提示词 / 提醒内容' : '提示词（报告类可留空）'}
            rules={promptRequired ? [{ required: true, message: '请填写提示词或提醒内容' }] : []}
          >
            <Input.TextArea rows={3} placeholder="到点交给机器人执行的需求，或提醒文本" />
          </Form.Item>
          <Form.Item name="scheduleType" label="调度方式">
            <Radio.Group
              options={[
                { value: 'interval', label: '固定间隔' },
                { value: 'cron', label: 'cron（Asia/Shanghai）' },
              ]}
              optionType="button"
            />
          </Form.Item>
          {scheduleType === 'cron' ? (
            <Form.Item
              name="cron"
              label="cron 表达式（5 段）"
              rules={[{ required: true, message: '请填写 cron 表达式' }]}
            >
              <Input placeholder="0 9 * * * 表示每天 09:00" />
            </Form.Item>
          ) : (
            <Form.Item
              name="intervalSeconds"
              label="间隔秒数（≥ 30）"
              rules={[{ required: true, message: '请填写间隔秒数' }]}
            >
              <InputNumber min={30} step={30} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="createdBy" label="创建者 staffId（可选）">
            <Input placeholder="留空记为 admin-api；个人任务建议填本人 staffId" disabled={editing} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}