import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined, UserSwitchOutlined } from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  KnownGroup,
  PersonIdentity,
  PersonaProfile,
  PersonaScope,
} from '../types';

interface PersonaForm {
  name: string;
  rolePrompt: string;
  speakingStyle: string;
  enabled: boolean;
}

interface BindForm {
  alias: string;
  staffId: string;
  displayName: string;
  mergeMemories: boolean;
}

export default function PersonaLayersPage() {
  const [scope, setScope] = useState<PersonaScope>('group');
  const [profiles, setProfiles] = useState<PersonaProfile[]>([]);
  const [groups, setGroups] = useState<KnownGroup[]>([]);
  const [people, setPeople] = useState<PersonIdentity[]>([]);
  const [identityQuery, setIdentityQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [identitiesLoading, setIdentitiesLoading] = useState(false);

  const [form] = Form.useForm<PersonaForm>();
  const [modal, setModal] = useState<{
    open: boolean;
    subjectKey?: string;
    editing?: PersonaProfile;
  }>({ open: false });
  const [saving, setSaving] = useState(false);

  const [bindForm] = Form.useForm<BindForm>();
  const [bindOpen, setBindOpen] = useState(false);
  const [binding, setBinding] = useState(false);

  const loadProfiles = useCallback(async (nextScope: PersonaScope) => {
    setLoading(true);
    try {
      const result = await api.personas(nextScope);
      setProfiles(result.profiles);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      const result = await api.groups();
      setGroups(result.groups);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadIdentities = useCallback(async (query?: string) => {
    setIdentitiesLoading(true);
    try {
      const result = await api.identities(query);
      setPeople(result.people);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIdentitiesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles(scope);
  }, [loadProfiles, scope]);

  useEffect(() => {
    void loadGroups();
    void loadIdentities();
  }, [loadGroups, loadIdentities]);

  const subjectOptions = (
    scope === 'group'
      ? groups.map((group) => ({
        value: group.conversationId,
        label: group.title
          ? `${group.title}（${group.conversationId}）`
          : group.conversationId,
      }))
      : people.map((person) => ({
        value: person.personKey,
        label: person.displayName
          ? `${person.displayName}（${person.personKey}）`
          : person.personKey,
      }))
  );

  const subjectLabel = (profile: PersonaProfile): string => {
    if (profile.scope === 'group') {
      const group = groups.find(
        (item) => item.conversationId === profile.subjectKey,
      );
      return group?.title
        ? `${group.title}（${profile.subjectKey}）`
        : profile.subjectKey;
    }
    const person = people.find((item) => item.personKey === profile.subjectKey);
    return person?.displayName
      ? `${person.displayName}（${profile.subjectKey}）`
      : profile.subjectKey;
  };

  const openCreate = () => {
    setModal({ open: true });
    form.setFieldsValue({
      name: '',
      rolePrompt: '',
      speakingStyle: '',
      enabled: true,
    });
  };

  const openEdit = (profile: PersonaProfile) => {
    setModal({ open: true, subjectKey: profile.subjectKey, editing: profile });
    form.setFieldsValue({
      name: profile.name,
      rolePrompt: profile.rolePrompt,
      speakingStyle: profile.speakingStyle,
      enabled: profile.enabled,
    });
  };

  const save = async (values: PersonaForm) => {
    const subjectKey = (modal.editing?.subjectKey ?? modal.subjectKey ?? '').trim();
    if (!subjectKey) {
      message.error(scope === 'group' ? '请选择群' : '请选择或输入员工标识');
      return;
    }
    setSaving(true);
    try {
      await api.savePersona(scope, subjectKey, {
        name: values.name?.trim() ?? '',
        rolePrompt: values.rolePrompt ?? '',
        speakingStyle: values.speakingStyle?.trim() ?? '',
        enabled: values.enabled,
      });
      message.success('人设已保存并热更新');
      setModal({ open: false });
      await loadProfiles(scope);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (profile: PersonaProfile) => {
    try {
      await api.deletePersona(profile.scope, profile.subjectKey);
      message.success('已移除该层人设，回落到上一层');
      await loadProfiles(scope);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const submitBind = async (values: BindForm) => {
    setBinding(true);
    try {
      const result = await api.bindIdentity({
        alias: values.alias.trim(),
        staffId: values.staffId.trim(),
        ...(values.displayName?.trim()
          ? { displayName: values.displayName.trim() }
          : {}),
        mergeMemories: values.mergeMemories,
      });
      message.success(
        `已绑定到 ${result.personKey}：迁移记忆 ${result.migratedMemories} 条、人设 ${result.migratedPersonas} 条`,
      );
      setBindOpen(false);
      bindForm.resetFields();
      await Promise.all([loadIdentities(identityQuery), loadProfiles(scope)]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBinding(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="人设按「系统默认 → 群设定 → 个人设定」逐层覆盖：群设定负责该群的职责与语气；个人设定在单聊中可整体覆盖，在群聊中只调整表达风格，不改变群的职责。安全与权限边界不可被任何人设覆盖。"
      />

      <Card
        title="分层人设"
        className="console-card"
        extra={
          <Space>
            <Segmented
              value={scope}
              options={[
                { value: 'group', label: '群人设' },
                { value: 'user', label: '个人表达偏好' },
              ]}
              onChange={(value) => setScope(value as PersonaScope)}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void loadProfiles(scope)}
            >
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              {scope === 'group' ? '新增群人设' : '新增个人人设'}
            </Button>
          </Space>
        }
      >
        <Table<PersonaProfile>
          rowKey={(row) => `${row.scope}:${row.subjectKey}`}
          size="small"
          loading={loading}
          dataSource={profiles}
          pagination={false}
          locale={{
            emptyText:
              scope === 'group'
                ? '暂无群人设，所有群使用系统默认人设'
                : '暂无个人表达偏好，所有员工使用系统或群人设',
          }}
          expandable={{
            expandedRowRender: (profile) => (
              <pre
                style={{
                  background: '#f6f8ff',
                  padding: 12,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                }}
              >
                {profile.rolePrompt || '（未设置职责 Prompt）'}
              </pre>
            ),
          }}
          columns={[
            {
              title: scope === 'group' ? '群' : '员工',
              key: 'subject',
              width: 280,
              render: (_, row) => subjectLabel(row),
            },
            {
              title: '名称',
              dataIndex: 'name',
              width: 160,
              render: (value: string) => value || '-',
            },
            {
              title: '说话风格',
              dataIndex: 'speakingStyle',
              ellipsis: true,
              render: (value: string) => value || '-',
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 80,
              render: (value: boolean) =>
                value ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
            },
            {
              title: '最后更新',
              dataIndex: 'updatedAt',
              width: 170,
              render: (value: number) =>
                value ? formatShanghaiDateTime(value) : '-',
            },
            {
              title: '操作',
              key: 'actions',
              width: 130,
              render: (_, row) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="移除该层人设？"
                    description="移除后该群/员工回落到上一层人设或系统默认。"
                    onConfirm={() => void remove(row)}
                  >
                    <Button size="small" danger>
                      移除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="身份绑定（钉钉 staffId 与开放 ID 归一）"
        className="console-card"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="搜索姓名 / 标识"
              style={{ width: 240 }}
              value={identityQuery}
              onChange={(event) => setIdentityQuery(event.target.value)}
              onSearch={(value) => void loadIdentities(value)}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={identitiesLoading}
              onClick={() => void loadIdentities(identityQuery)}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<UserSwitchOutlined />}
              onClick={() => {
                bindForm.setFieldsValue({
                  alias: '',
                  staffId: '',
                  displayName: '',
                  mergeMemories: true,
                });
                setBindOpen(true);
              }}
            >
              绑定身份
            </Button>
          </Space>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="群旁听事件只能拿到 openDingTalkId，机器人消息能拿到 staffId。未绑定时两者会被当作不同的人，记忆与人设互不相通；确认是同一员工后再绑定。"
        />
        <Table<PersonIdentity>
          rowKey="personKey"
          size="small"
          loading={identitiesLoading}
          dataSource={people}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            {
              title: '人员',
              key: 'person',
              width: 240,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>
                    {row.displayName || '未命名'}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.personKey}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '别名',
              key: 'aliases',
              render: (_, row) => (
                <Space wrap size={4}>
                  {row.aliases.length === 0 && <Tag>无</Tag>}
                  {row.aliases.map((alias) => (
                    <Tooltip
                      key={alias.alias}
                      title={`来源：${alias.source} · ${formatShanghaiDateTime(alias.updatedAt)}`}
                    >
                      <Tag color={alias.source === 'open' ? 'orange' : 'blue'}>
                        {alias.alias}
                      </Tag>
                    </Tooltip>
                  ))}
                </Space>
              ),
            },
            {
              title: '合并到',
              dataIndex: 'mergedInto',
              width: 220,
              render: (value: string | null) =>
                value ? <Tag color="purple">{value}</Tag> : '-',
            },
            {
              title: '最后更新',
              dataIndex: 'updatedAt',
              width: 170,
              render: (value: number) =>
                value ? formatShanghaiDateTime(value) : '-',
            },
          ]}
        />
      </Card>

      <Modal
        title={
          modal.editing
            ? '编辑人设'
            : scope === 'group'
              ? '新增群人设'
              : '新增个人人设'
        }
        open={modal.open}
        confirmLoading={saving}
        onCancel={() => setModal({ open: false })}
        onOk={() => void form.submit()}
        okText="保存并热更新"
        width={720}
      >
        {!modal.editing && (
          <Form.Item label={scope === 'group' ? '群' : '员工（staffId 或 personKey）'}>
            <AutoComplete
              value={modal.subjectKey}
              options={subjectOptions}
              placeholder={
                scope === 'group'
                  ? '选择群，或直接输入 conversationId'
                  : '选择员工，或直接输入 staffId'
              }
              filterOption={(input, option) =>
                String(option?.label ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={(value) =>
                setModal((prev) => ({ ...prev, subjectKey: value }))
              }
            />
          </Form.Item>
        )}
        {modal.editing && (
          <Typography.Paragraph type="secondary">
            对象：{modal.editing.subjectKey}
          </Typography.Paragraph>
        )}
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item
            label={scope === 'group' ? '群内名称' : '单聊名称'}
            name="name"
            extra={
              scope === 'user'
                ? '群聊中个人名称不会覆盖群设定，只影响单聊。'
                : undefined
            }
          >
            <Input />
          </Form.Item>
          <Form.Item
            label={scope === 'group' ? '群内职责 Prompt' : '个人职责 / 偏好 Prompt'}
            name="rolePrompt"
            extra={
              scope === 'user'
                ? '群聊中该 Prompt 不生效，避免个人偏好改变群职责；仅单聊生效。'
                : '描述机器人在这类群里负责什么、不负责什么。'
            }
          >
            <Input.TextArea rows={5} />
          </Form.Item>
          <Form.Item
            label="说话风格"
            name="speakingStyle"
            extra="个人设定在群聊中通过此字段调整表达，不改变群职责。"
          >
            <Input />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="绑定身份"
        open={bindOpen}
        confirmLoading={binding}
        onCancel={() => setBindOpen(false)}
        onOk={() => void bindForm.submit()}
        okText="绑定并迁移"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="别名可填 open:xxx、staff:xxx 或直接填 ID；目标填员工 staffId 或 personKey。绑定后会把旧人员的个人记忆与人设迁移到目标人员。"
        />
        <Form form={bindForm} layout="vertical" onFinish={submitBind}>
          <Form.Item
            label="待绑定别名"
            name="alias"
            rules={[{ required: true, message: '请输入 openDingTalkId 或别名' }]}
          >
            <Input placeholder="例如 open:abcd1234 或 abcd1234" />
          </Form.Item>
          <Form.Item
            label="目标员工 staffId"
            name="staffId"
            rules={[{ required: true, message: '请输入目标员工 staffId' }]}
          >
            <Input placeholder="例如 0137000000000000" />
          </Form.Item>
          <Form.Item label="显示名（可选）" name="displayName">
            <Input placeholder="例如：张三" />
          </Form.Item>
          <Form.Item
            label="迁移旧人员的记忆与人设"
            name="mergeMemories"
            valuePropName="checked"
            extra="仅在同一员工的两个 ID 被误拆时开启；不同员工的记忆不要合并。"
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
