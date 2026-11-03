import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  GroupGoalRecord,
  GroupGoalStatus,
  GroupTaskRecord,
  GroupTaskStatus,
  GroupWorkspaceSnapshot,
  KnownGroup,
} from '../types';

interface WorkspaceForm {
  title: string;
  purpose: string;
  responsibilities: string[];
}

interface GoalForm {
  title: string;
  detail: string;
  progress?: number;
  ownerName: string;
  due?: string;
}

interface TaskForm {
  title: string;
  detail: string;
  goalId?: string;
  assigneeName: string;
  due?: string;
}

const GOAL_STATUS_LABELS: Record<GroupGoalStatus, string> = {
  active: '进行中',
  achieved: '已达成',
  paused: '已暂停',
  archived: '已归档',
};

const TASK_STATUS_LABELS: Record<GroupTaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};

function dueToTimestamp(due?: string): number | null {
  if (!due) return null;
  return Date.parse(`${due}T23:59:59+08:00`);
}

function timestampToDue(value: number | null): string | undefined {
  return value ? formatShanghaiDateTime(value).slice(0, 10) : undefined;
}

export default function GroupWorkspacePage() {
  const [groups, setGroups] = useState<KnownGroup[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [snapshot, setSnapshot] = useState<GroupWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [workspaceForm] = Form.useForm<WorkspaceForm>();
  const [goalForm] = Form.useForm<GoalForm>();
  const [taskForm] = Form.useForm<TaskForm>();
  const [goalModal, setGoalModal] = useState<{ open: boolean; editing?: GroupGoalRecord }>({
    open: false,
  });
  const [taskModal, setTaskModal] = useState<{ open: boolean; editing?: GroupTaskRecord }>({
    open: false,
  });
  const requestSeq = useRef(0);

  const loadGroups = useCallback(async () => {
    try {
      const result = await api.groups();
      setGroups(result.groups);
      setConversationId((current) => current ?? result.groups[0]?.conversationId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadSnapshot = useCallback(async (id: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const result = await api.groupWorkspace(id);
      if (seq !== requestSeq.current) return;
      setSnapshot(result);
      workspaceForm.setFieldsValue({
        title: result.workspace.title,
        purpose: result.workspace.purpose,
        responsibilities: result.workspace.responsibilities,
      });
    } catch (error) {
      if (seq === requestSeq.current) {
        message.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [workspaceForm]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (conversationId) void loadSnapshot(conversationId);
  }, [conversationId, loadSnapshot]);

  const groupOptions = useMemo(
    () =>
      groups.map((group) => ({
        value: group.conversationId,
        label: group.title
          ? `${group.title}（${group.conversationId}）`
          : group.conversationId,
      })),
    [groups],
  );

  const goalOptions = useMemo(
    () =>
      (snapshot?.goals ?? [])
        .filter((goal) => goal.status !== 'archived')
        .map((goal) => ({ value: goal.id, label: goal.title })),
    [snapshot],
  );

  const saveWorkspace = async (values: WorkspaceForm) => {
    if (!conversationId) return;
    setSaving(true);
    try {
      await api.updateGroupWorkspace(conversationId, {
        title: values.title ?? '',
        purpose: values.purpose ?? '',
        responsibilities: (values.responsibilities ?? []).filter(Boolean),
      });
      message.success('群工作区已保存，下一条群消息立即生效');
      await loadSnapshot(conversationId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const submitGoal = async (values: GoalForm) => {
    if (!conversationId) return;
    setSaving(true);
    try {
      if (goalModal.editing) {
        await api.updateGroupGoal(conversationId, goalModal.editing.id, {
          title: values.title,
          detail: values.detail ?? '',
          progress: values.progress,
          ownerName: values.ownerName ?? '',
          dueAt: dueToTimestamp(values.due),
        });
      } else {
        await api.createGroupGoal(conversationId, {
          title: values.title,
          detail: values.detail ?? '',
          progress: values.progress ?? 0,
          ownerName: values.ownerName ?? '',
          dueAt: dueToTimestamp(values.due),
        });
      }
      message.success('群目标已保存');
      setGoalModal({ open: false });
      await loadSnapshot(conversationId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const submitTask = async (values: TaskForm) => {
    if (!conversationId) return;
    setSaving(true);
    try {
      if (taskModal.editing) {
        await api.updateGroupTask(conversationId, taskModal.editing.id, {
          title: values.title,
          detail: values.detail ?? '',
          goalId: values.goalId ?? null,
          assigneeName: values.assigneeName ?? '',
          dueAt: dueToTimestamp(values.due),
        });
      } else {
        await api.createGroupTask(conversationId, {
          title: values.title,
          detail: values.detail ?? '',
          goalId: values.goalId ?? null,
          assigneeName: values.assigneeName ?? '',
          dueAt: dueToTimestamp(values.due),
        });
      }
      message.success('群任务已保存');
      setTaskModal({ open: false });
      await loadSnapshot(conversationId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const changeGoalStatus = async (
    goal: GroupGoalRecord,
    status: GroupGoalStatus,
  ) => {
    if (!conversationId) return;
    try {
      await api.updateGroupGoal(conversationId, goal.id, { status });
      await loadSnapshot(conversationId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const changeTaskStatus = async (
    task: GroupTaskRecord,
    status: GroupTaskStatus,
  ) => {
    if (!conversationId) return;
    try {
      await api.updateGroupTask(conversationId, task.id, { status });
      await loadSnapshot(conversationId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="群工作区把「这个群负责什么、要达成什么、还有哪些事」变成可持续维护的上下文：系统提示会自动带上群定位、职责与未完成目标/任务，群成员也可以直接用 /group 维护。"
      />

      <Card className="console-card">
        <Space wrap>
          <Typography.Text strong>选择群</Typography.Text>
          <Select
            style={{ width: 460 }}
            showSearch
            optionFilterProp="label"
            placeholder="选择要维护的钉钉群"
            value={conversationId}
            options={groupOptions}
            onChange={(value) => {
              requestSeq.current += 1;
              setSnapshot(null);
              setGoalModal({ open: false });
              setTaskModal({ open: false });
              setConversationId(value);
            }}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!conversationId}
            onClick={() => conversationId && void loadSnapshot(conversationId)}
          >
            刷新
          </Button>
        </Space>
      </Card>

      {!conversationId ? (
        <Card className="console-card">
          <Empty description="暂无已接入的群；先在「群聊旁听策略」中保存一次群策略，让群进入目录" />
        </Card>
      ) : (
        <>
          <Card
            title="群定位与职责"
            className="console-card"
            extra={
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                onClick={() => void workspaceForm.submit()}
              >
                保存
              </Button>
            }
          >
            <Form form={workspaceForm} layout="vertical" onFinish={saveWorkspace}>
              <Form.Item label="群名称（备注）" name="title">
                <Input placeholder="例如：支付平台值班群" />
              </Form.Item>
              <Form.Item
                label="群定位 / 长期目标"
                name="purpose"
                extra="用一两句话说明这个群存在的目的，例如「负责支付链路稳定性与线上故障响应」。"
              >
                <Input.TextArea rows={3} />
              </Form.Item>
              <Form.Item
                label="群职责"
                name="responsibilities"
                extra="列出机器人应该在本群承担的事项；不负责的事项也可以写明，避免越界。"
              >
                <Select mode="tags" placeholder="输入一条职责后回车" />
              </Form.Item>
            </Form>
          </Card>

          <Card
            title="群目标"
            className="console-card"
            extra={
              <Button
                icon={<PlusOutlined />}
                onClick={() => {
                  goalForm.resetFields();
                  setGoalModal({ open: true });
                }}
              >
                新增目标
              </Button>
            }
          >
            <Table<GroupGoalRecord>
              rowKey="id"
              size="small"
              dataSource={snapshot?.goals ?? []}
              pagination={false}
              locale={{ emptyText: '暂无群目标' }}
              columns={[
                {
                  title: '目标',
                  key: 'title',
                  render: (_, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{row.title}</Typography.Text>
                      {row.detail ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.detail}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: '进度',
                  dataIndex: 'progress',
                  width: 130,
                  render: (value: number) => (
                    <Progress percent={value} size="small" />
                  ),
                },
                {
                  title: '负责人',
                  dataIndex: 'ownerName',
                  width: 120,
                  render: (value: string) => value || '-',
                },
                {
                  title: '截止',
                  dataIndex: 'dueAt',
                  width: 170,
                  render: (value: number | null) =>
                    value ? formatShanghaiDateTime(value) : '-',
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 130,
                  render: (value: GroupGoalStatus, row) => (
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={value}
                      options={Object.entries(GOAL_STATUS_LABELS).map(
                        ([key, label]) => ({ value: key, label }),
                      )}
                      onChange={(next) =>
                        void changeGoalStatus(row, next as GroupGoalStatus)
                      }
                    />
                  ),
                },
                {
                  title: '操作',
                  key: 'actions',
                  width: 140,
                  render: (_, row) => (
                    <Space size={4}>
                      <Button
                        size="small"
                        onClick={() => {
                          goalForm.setFieldsValue({
                            title: row.title,
                            detail: row.detail,
                            progress: row.progress,
                            ownerName: row.ownerName,
                            due: timestampToDue(row.dueAt),
                          });
                          setGoalModal({ open: true, editing: row });
                        }}
                      >
                        编辑
                      </Button>
                      <Popconfirm
                        title="删除该群目标？"
                        onConfirm={() => {
                          if (!conversationId) return;
                          void api
                            .deleteGroupGoal(conversationId, row.id)
                            .then(() => loadSnapshot(conversationId))
                            .catch((error: unknown) =>
                              message.error(
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                              ),
                            );
                        }}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card
            title="群任务"
            className="console-card"
            extra={
              <Button
                icon={<PlusOutlined />}
                onClick={() => {
                  taskForm.resetFields();
                  setTaskModal({ open: true });
                }}
              >
                新增任务
              </Button>
            }
          >
            <Table<GroupTaskRecord>
              rowKey="id"
              size="small"
              dataSource={snapshot?.tasks ?? []}
              pagination={false}
              locale={{ emptyText: '暂无群任务' }}
              columns={[
                {
                  title: '任务',
                  key: 'title',
                  render: (_, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{row.title}</Typography.Text>
                      {row.detail ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.detail}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  title: '关联目标',
                  dataIndex: 'goalId',
                  width: 160,
                  render: (value: string | null) =>
                    value
                      ? goalOptions.find((option) => option.value === value)
                          ?.label ?? '-'
                      : '-',
                },
                {
                  title: '负责人',
                  dataIndex: 'assigneeName',
                  width: 120,
                  render: (value: string) => value || '-',
                },
                {
                  title: '截止',
                  dataIndex: 'dueAt',
                  width: 170,
                  render: (value: number | null) =>
                    value ? formatShanghaiDateTime(value) : '-',
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 130,
                  render: (value: GroupTaskStatus, row) => (
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={value}
                      options={Object.entries(TASK_STATUS_LABELS).map(
                        ([key, label]) => ({ value: key, label }),
                      )}
                      onChange={(next) =>
                        void changeTaskStatus(row, next as GroupTaskStatus)
                      }
                    />
                  ),
                },
                {
                  title: '完成时间',
                  dataIndex: 'completedAt',
                  width: 170,
                  render: (value: number | null) =>
                    value ? formatShanghaiDateTime(value) : '-',
                },
                {
                  title: '操作',
                  key: 'actions',
                  width: 140,
                  render: (_, row) => (
                    <Space size={4}>
                      <Button
                        size="small"
                        onClick={() => {
                          taskForm.setFieldsValue({
                            title: row.title,
                            detail: row.detail,
                            goalId: row.goalId ?? undefined,
                            assigneeName: row.assigneeName,
                            due: timestampToDue(row.dueAt),
                          });
                          setTaskModal({ open: true, editing: row });
                        }}
                      >
                        编辑
                      </Button>
                      <Popconfirm
                        title="删除该群任务？"
                        onConfirm={() => {
                          if (!conversationId) return;
                          void api
                            .deleteGroupTask(conversationId, row.id)
                            .then(() => loadSnapshot(conversationId))
                            .catch((error: unknown) =>
                              message.error(
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                              ),
                            );
                        }}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}

      <Modal
        title={goalModal.editing ? '编辑群目标' : '新增群目标'}
        open={goalModal.open}
        confirmLoading={saving}
        onCancel={() => setGoalModal({ open: false })}
        onOk={() => void goalForm.submit()}
        okText="保存"
      >
        <Form form={goalForm} layout="vertical" onFinish={submitGoal}>
          <Form.Item
            label="目标标题"
            name="title"
            rules={[{ required: true, message: '请输入目标标题' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="说明 / 验收标准" name="detail">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="进度（0–100）" name="progress">
            <InputNumber min={0} max={100} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="负责人（可选）" name="ownerName">
            <Input />
          </Form.Item>
          <Form.Item label="截止日期（可选）" name="due">
            <Input type="date" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={taskModal.editing ? '编辑群任务' : '新增群任务'}
        open={taskModal.open}
        confirmLoading={saving}
        onCancel={() => setTaskModal({ open: false })}
        onOk={() => void taskForm.submit()}
        okText="保存"
      >
        <Form form={taskForm} layout="vertical" onFinish={submitTask}>
          <Form.Item
            label="任务标题"
            name="title"
            rules={[{ required: true, message: '请输入任务标题' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="说明" name="detail">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="关联目标（可选）" name="goalId">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择该任务归属的群目标"
              options={goalOptions}
            />
          </Form.Item>
          <Form.Item label="负责人（可选）" name="assigneeName">
            <Input />
          </Form.Item>
          <Form.Item label="截止日期（可选）" name="due">
            <Input type="date" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
