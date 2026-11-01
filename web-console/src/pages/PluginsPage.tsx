import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { UploadFile, UploadProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  PluginAdminView,
  PluginPackagePreview,
  PluginStatus,
  PluginValidationIssue,
  PluginVersionRecord,
  PluginVersionStatus,
} from '../types';

const STATUS_COLOR: Record<PluginStatus, string> = {
  enabled: 'green',
  disabled: 'default',
  installed: 'blue',
  degraded: 'orange',
  error: 'red',
};

const STATUS_LABEL: Record<PluginStatus, string> = {
  enabled: '已启用',
  disabled: '已停用',
  installed: '已安装',
  degraded: '降级',
  error: '异常',
};

const VERSION_STATUS_COLOR: Record<PluginVersionStatus, string> = {
  enabled: 'green',
  disabled: 'default',
  installed: 'blue',
  degraded: 'orange',
  error: 'red',
  superseded: 'default',
};

function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return formatShanghaiDateTime(ms);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function IssueList({
  title,
  issues,
}: {
  title: string;
  issues: PluginValidationIssue[];
}) {
  if (issues.length === 0) return null;
  return (
    <Card size="small" title={title} style={{ width: '100%' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {issues.map((issue, index) => (
          <Typography.Text
            key={`${issue.path}-${index}`}
            type={issue.severity === 'error' ? 'danger' : 'warning'}
          >
            [{issue.severity}] {issue.path}：{issue.message}
          </Typography.Text>
        ))}
      </Space>
    </Card>
  );
}

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginAdminView[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PluginStatus | undefined>();

  const [installOpen, setInstallOpen] = useState(false);
  const [installMode, setInstallMode] = useState<'install' | 'upgrade'>('install');
  const [upgradeTarget, setUpgradeTarget] = useState<PluginAdminView | null>(null);
  const [sourceMode, setSourceMode] = useState<'upload' | 'path'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [serverPath, setServerPath] = useState('');
  const [force, setForce] = useState(false);
  const [allowMissingSecrets, setAllowMissingSecrets] = useState(false);
  const [preview, setPreview] = useState<PluginPackagePreview | null>(null);
  const [working, setWorking] = useState(false);

  const [detail, setDetail] = useState<PluginAdminView | null>(null);
  const [versions, setVersions] = useState<PluginVersionRecord[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { plugins: items } = await api.plugins({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      });
      setPlugins(items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadVersions = async (id: string) => {
    setVersionsLoading(true);
    try {
      const { versions: items } = await api.pluginVersions(id);
      setVersions(items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionsLoading(false);
    }
  };

  const openInstall = (target?: PluginAdminView) => {
    setUpgradeTarget(target ?? null);
    setInstallMode(target ? 'upgrade' : 'install');
    setFile(null);
    setServerPath('');
    setForce(false);
    setAllowMissingSecrets(false);
    setPreview(null);
    setInstallOpen(true);
  };

  const handleValidate = async () => {
    setWorking(true);
    try {
      const result =
        sourceMode === 'upload'
          ? file
            ? await api.validatePluginFile(file)
            : null
          : serverPath.trim()
            ? await api.validatePlugin({
                ...(serverPath.trim().toLowerCase().endsWith('.zip')
                  ? { path: serverPath.trim() }
                  : { dir: serverPath.trim() }),
              })
            : null;
      if (!result) {
        message.warning('请先选择 zip 包或填写服务器路径');
        return;
      }
      setPreview(result.preview);
      if (result.preview.conflicts.length > 0) {
        message.warning('校验发现阻断问题，请先处理冲突');
      } else {
        message.success('校验通过');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const handleInstall = async () => {
    const flags = { force, allowMissingSecrets };
    setWorking(true);
    try {
      if (sourceMode === 'upload' && file) {
        const result = await api.uploadPlugin(file, {
          ...flags,
          mode: installMode,
          ...(upgradeTarget ? { id: upgradeTarget.id } : {}),
        });
        message.success(installMode === 'upgrade' ? '插件已升级' : '插件已安装');
        if (result.warnings.length > 0) {
          message.warning(`安装完成，有 ${result.warnings.length} 条警告`);
        }
      } else if (serverPath.trim()) {
        if (installMode === 'upgrade' && upgradeTarget) {
          await api.upgradePluginPath(upgradeTarget.id, {
            ...flags,
            ...(serverPath.trim().toLowerCase().endsWith('.zip')
              ? { path: serverPath.trim() }
              : { dir: serverPath.trim() }),
          });
        } else {
          await api.installPluginPath({
            ...flags,
            ...(serverPath.trim().toLowerCase().endsWith('.zip')
              ? { path: serverPath.trim() }
              : { dir: serverPath.trim() }),
          });
        }
        message.success(installMode === 'upgrade' ? '插件已升级' : '插件已安装');
      } else {
        message.warning('请先选择 zip 包或填写服务器路径');
        return;
      }
      setInstallOpen(false);
      await load();
      if (detail) {
        const { plugin } = await api.plugin(detail.id);
        setDetail(plugin);
        await loadVersions(plugin.id);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const handleToggle = async (plugin: PluginAdminView, enable: boolean) => {
    try {
      if (enable) await api.enablePlugin(plugin.id);
      else await api.disablePlugin(plugin.id);
      message.success(enable ? '插件已启用' : '插件已停用');
      await load();
      if (detail?.id === plugin.id) {
        const { plugin: updated } = await api.plugin(plugin.id);
        setDetail(updated);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRollback = async (plugin: PluginAdminView, version: string) => {
    try {
      await api.rollbackPlugin(plugin.id, version);
      message.success(`已回滚到 ${version}`);
      await load();
      await loadVersions(plugin.id);
      const { plugin: updated } = await api.plugin(plugin.id);
      setDetail(updated);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUninstall = async (plugin: PluginAdminView, deleteFiles: boolean) => {
    try {
      await api.uninstallPlugin(plugin.id, deleteFiles);
      message.success('插件已卸载');
      setDetail(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const uploadProps: UploadProps = {
    accept: '.zip',
    maxCount: 1,
    beforeUpload: (next) => {
      setFile(next);
      setPreview(null);
      return false;
    },
    onRemove: () => {
      setFile(null);
      setPreview(null);
    },
    fileList: file
      ? ([{ uid: '-1', name: file.name, status: 'done' }] satisfies UploadFile[])
      : [],
  };

  const columns: ColumnsType<PluginAdminView> = [
    {
      title: '插件',
      dataIndex: 'name',
      render: (_value, plugin) => (
        <Space direction="vertical" size={0}>
          <Space>
            <Typography.Text strong>{plugin.name}</Typography.Text>
            <Tag color={STATUS_COLOR[plugin.status]}>
              {STATUS_LABEL[plugin.status]}
            </Tag>
            {!plugin.runtimeApplied && plugin.status === 'enabled' ? (
              <Tag color="orange">运行时未生效</Tag>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {plugin.id}@{plugin.activeVersion} · {plugin.manifest.publisher ?? '未标注发布者'}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {plugin.manifest.description}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '技能',
      dataIndex: 'skills',
      width: 200,
      render: (_value, plugin) => (
        <Space direction="vertical" size={2}>
          {plugin.skills.length === 0 ? (
            <Typography.Text type="secondary">无</Typography.Text>
          ) : (
            plugin.skills.map((skill) => (
              <Typography.Text
                key={skill.id}
                type={skill.loadError ? 'danger' : undefined}
                style={{ fontSize: 12 }}
              >
                {skill.name}
                {skill.loadError ? '（加载失败）' : ''}
              </Typography.Text>
            ))
          )}
        </Space>
      ),
    },
    {
      title: 'MCP 服务',
      dataIndex: 'mcpServerIds',
      width: 220,
      render: (ids: string[]) =>
        ids.length === 0 ? (
          <Typography.Text type="secondary">无</Typography.Text>
        ) : (
          <Space direction="vertical" size={2}>
            {ids.map((id) => (
              <Typography.Text key={id} code style={{ fontSize: 12 }}>
                {id}
              </Typography.Text>
            ))}
          </Space>
        ),
    },
    {
      title: '密钥',
      dataIndex: 'missingSecrets',
      width: 160,
      render: (missing: string[]) =>
        missing.length === 0 ? (
          <Tag color="green">齐全</Tag>
        ) : (
          <Space direction="vertical" size={2}>
            {missing.map((key) => (
              <Tag key={key} color="red">
                {key}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: number) => formatTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_value, plugin) => (
        <Space wrap>
          <Button
            size="small"
            onClick={() => {
              setDetail(plugin);
              void loadVersions(plugin.id);
            }}
          >
            详情
          </Button>
          {plugin.status === 'enabled' ? (
            <Button size="small" onClick={() => void handleToggle(plugin, false)}>
              停用
            </Button>
          ) : (
            <Button
              size="small"
              type="primary"
              disabled={plugin.missingSecrets.length > 0}
              onClick={() => void handleToggle(plugin, true)}
            >
              启用
            </Button>
          )}
          <Button size="small" onClick={() => openInstall(plugin)}>
            升级
          </Button>
          <Popconfirm
            title="卸载插件？"
            description="默认保留插件目录 7 天，可在详情中勾选立即删除。"
            onConfirm={() => void handleUninstall(plugin, false)}
          >
            <Button size="small" danger>
              卸载
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space wrap>
          <Input.Search
            placeholder="搜索插件 id / 名称 / 描述"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void load()}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            placeholder="状态"
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 140 }}
            options={(Object.keys(STATUS_LABEL) as PluginStatus[]).map((status) => ({
              value: status,
              label: STATUS_LABEL[status],
            }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={() => openInstall()}
          >
            安装插件
          </Button>
        </Space>
      </Card>

      <Card>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={plugins}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (plugin) =>
              plugin.lastError ? (
                <Alert type="error" showIcon message={plugin.lastError} />
              ) : (
                <Typography.Text type="secondary">无最近错误</Typography.Text>
              ),
            rowExpandable: (plugin) => Boolean(plugin.lastError),
          }}
        />
      </Card>

      <Modal
        title={installMode === 'upgrade' ? `升级插件：${upgradeTarget?.id}` : '安装声明式插件'}
        open={installOpen}
        onCancel={() => setInstallOpen(false)}
        width={820}
        onOk={() => void handleInstall()}
        okText={installMode === 'upgrade' ? '升级' : '安装'}
        confirmLoading={working}
        okButtonProps={{
          disabled: preview ? preview.conflicts.length > 0 : false,
        }}
        footer={(originNode) => (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button
              icon={<SafetyCertificateOutlined />}
              onClick={() => void handleValidate()}
            >
              仅校验
            </Button>
            <Space>{originNode}</Space>
          </Space>
        )}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="插件只允许声明式内容（技能、MCP、资源、密钥引用），不会执行任意代码。"
            description="安装前会校验 zip 路径逃逸、符号链接、可执行文件、MCP 命名空间冲突与缺失密钥。"
          />
          <Radio.Group
            value={sourceMode}
            onChange={(event) => setSourceMode(event.target.value)}
          >
            <Radio.Button value="upload">上传 zip</Radio.Button>
            <Radio.Button value="path">服务器路径</Radio.Button>
          </Radio.Group>
          {sourceMode === 'upload' ? (
            <Upload {...uploadProps}>
              <Button icon={<CloudUploadOutlined />}>选择插件 zip（≤20MB）</Button>
            </Upload>
          ) : (
            <Input
              placeholder="服务器上的插件目录或 zip 路径"
              value={serverPath}
              onChange={(event) => {
                setServerPath(event.target.value);
                setPreview(null);
              }}
            />
          )}
          <Space>
            <Checkbox
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
            >
              强制覆盖同版本
            </Checkbox>
            <Checkbox
              checked={allowMissingSecrets}
              onChange={(event) => setAllowMissingSecrets(event.target.checked)}
            >
              允许缺失密钥（安装后保持停用）
            </Checkbox>
          </Space>

          {preview ? (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Descriptions size="small" bordered column={2}>
                <Descriptions.Item label="插件">
                  {preview.manifest.name}（{preview.manifest.id}@{preview.manifest.version}）
                </Descriptions.Item>
                <Descriptions.Item label="包大小">
                  {formatBytes(preview.packageBytes)}
                </Descriptions.Item>
                <Descriptions.Item label="描述" span={2}>
                  {preview.manifest.description}
                </Descriptions.Item>
                <Descriptions.Item label="已安装">
                  {preview.alreadyInstalled
                    ? `${preview.alreadyInstalled.version} / ${preview.alreadyInstalled.status}`
                    : '否'}
                </Descriptions.Item>
                <Descriptions.Item label="校验和">
                  <Typography.Text code>
                    {preview.checksum.slice(0, 16)}…
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="技能" span={2}>
                  {preview.skills.length === 0
                    ? '无'
                    : preview.skills
                        .map((skill) =>
                          skill.error
                            ? `${skill.name}（${skill.error}）`
                            : `${skill.name}@${skill.version}`,
                        )
                        .join('、')}
                </Descriptions.Item>
                <Descriptions.Item label="MCP" span={2}>
                  {preview.mcpServers.length === 0
                    ? '无'
                    : preview.mcpServers
                        .map((server) => `${server.id}（${server.transport}）`)
                        .join('、')}
                </Descriptions.Item>
                <Descriptions.Item label="缺失密钥" span={2}>
                  {preview.missingSecrets.length === 0
                    ? '无'
                    : preview.missingSecrets.join('、')}
                </Descriptions.Item>
              </Descriptions>
              <IssueList title="阻断问题" issues={preview.conflicts} />
              <IssueList title="警告" issues={preview.warnings} />
            </Space>
          ) : null}
        </Space>
      </Modal>

      <Drawer
        title={detail ? `插件详情：${detail.name}` : '插件详情'}
        open={Boolean(detail)}
        width={820}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={STATUS_COLOR[detail.status]}>{STATUS_LABEL[detail.status]}</Tag>
              <Tag color={detail.runtimeApplied ? 'green' : 'orange'}>
                {detail.runtimeApplied ? '运行时已生效' : '运行时未生效'}
              </Tag>
              <Tag>{detail.id}@{detail.activeVersion}</Tag>
            </Space>
            {detail.lastError ? (
              <Alert type="error" showIcon message={detail.lastError} />
            ) : null}
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="描述" span={2}>
                {detail.manifest.description}
              </Descriptions.Item>
              <Descriptions.Item label="发布者">
                {detail.manifest.publisher ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="许可证">
                {detail.manifest.license ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="安装人">{detail.installedBy}</Descriptions.Item>
              <Descriptions.Item label="安装时间">
                {formatTime(detail.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="缺失密钥" span={2}>
                {detail.missingSecrets.length === 0
                  ? '无'
                  : detail.missingSecrets.join('、')}
              </Descriptions.Item>
            </Descriptions>
            <Card size="small" title="技能">
              {detail.skills.length === 0 ? (
                <Typography.Text type="secondary">无</Typography.Text>
              ) : (
                <Space direction="vertical">
                  {detail.skills.map((skill) => (
                    <Typography.Text key={skill.id} type={skill.loadError ? 'danger' : undefined}>
                      {skill.name}（{skill.id}）
                      {skill.loadError ? `：${skill.loadError}` : ''}
                    </Typography.Text>
                  ))}
                </Space>
              )}
            </Card>
            <Card size="small" title="MCP 服务">
              {detail.mcpServerIds.length === 0 ? (
                <Typography.Text type="secondary">无</Typography.Text>
              ) : (
                <Space direction="vertical">
                  {detail.mcpServerIds.map((id) => (
                    <Typography.Text key={id} code>
                      {id}
                    </Typography.Text>
                  ))}
                </Space>
              )}
            </Card>
            <Card
              size="small"
              title="版本历史"
              extra={
                <Button size="small" onClick={() => void loadVersions(detail.id)}>
                  刷新
                </Button>
              }
            >
              <Table
                rowKey="version"
                size="small"
                loading={versionsLoading}
                pagination={false}
                dataSource={versions}
                columns={[
                  { title: '版本', dataIndex: 'version', width: 100 },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 100,
                    render: (status: PluginVersionStatus) => (
                      <Tag color={VERSION_STATUS_COLOR[status]}>{status}</Tag>
                    ),
                  },
                  {
                    title: '安装时间',
                    dataIndex: 'installedAt',
                    width: 180,
                    render: (value: number) => formatTime(value),
                  },
                  {
                    title: '校验和',
                    dataIndex: 'checksum',
                    render: (value: string) => (
                      <Typography.Text code>{value.slice(0, 12)}…</Typography.Text>
                    ),
                  },
                  {
                    title: '操作',
                    key: 'actions',
                    width: 100,
                    render: (_value, version) => (
                      <Button
                        size="small"
                        disabled={
                          version.version === detail.activeVersion ||
                          detail.missingSecrets.length > 0
                        }
                        onClick={() => void handleRollback(detail, version.version)}
                      >
                        回滚
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
            <Space>
              <Button onClick={() => openInstall(detail)}>升级</Button>
              {detail.status === 'enabled' ? (
                <Button onClick={() => void handleToggle(detail, false)}>停用</Button>
              ) : (
                <Button
                  type="primary"
                  disabled={detail.missingSecrets.length > 0}
                  onClick={() => void handleToggle(detail, true)}
                >
                  启用
                </Button>
              )}
              <Popconfirm
                title="卸载并立即删除插件文件？"
                description="会先停用并断开 MCP，再删除版本目录，无法恢复。"
                okText="删除"
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleUninstall(detail, true)}
              >
                <Button danger>卸载并删除文件</Button>
              </Popconfirm>
            </Space>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
