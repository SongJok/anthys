import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api, downloadTestcaseExport } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  CompiledTestcaseCase,
  TestcaseDefect,
  TestcaseExecutionStatus,
  TestcaseExportFormat,
  TestcaseRisk,
  TestcaseWorkspaceDetail,
  TestcaseWorkspaceSummary,
} from '../types';

const EXPORT_ITEMS: Array<{ key: TestcaseExportFormat; label: string }> = [
  { key: 'xlsx', label: '导出 Excel (.xlsx)' },
  { key: 'docx', label: '导出 Word (.docx)' },
  { key: 'csv', label: '导出 CSV (.csv)' },
  { key: 'md', label: '导出 Markdown (.md)' },
  { key: 'json', label: '导出结构化 JSON (.json)' },
];

const PRIORITY_COLOR: Record<'高' | '中' | '低', string> = {
  高: 'red',
  中: 'orange',
  低: 'blue',
};

const EXECUTION_LABEL: Record<TestcaseExecutionStatus, string> = {
  untested: '未执行',
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
};

const EXECUTION_COLOR: Record<TestcaseExecutionStatus, string> = {
  untested: 'default',
  passed: 'green',
  failed: 'red',
  blocked: 'orange',
};

const RISK_STATUS_LABEL: Record<TestcaseRisk['status'], string> = {
  open: '待处理',
  mitigated: '已缓解',
  accepted: '已接受',
};

const DEFECT_STATUS_LABEL: Record<TestcaseDefect['status'], string> = {
  open: '待修复',
  fixed: '已修复待验证',
  verified: '已验证',
  rejected: '已拒绝',
};

function renderLines(items: string[]) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
      {items.map((item, idx) => (
        <div key={`${idx}-${item.slice(0, 12)}`}>{`${idx + 1}. ${item}`}</div>
      ))}
    </div>
  );
}

export default function TestcaseWorkspacesPage() {
  const [items, setItems] = useState<TestcaseWorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [conversationFilter, setConversationFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [includeArchived, setIncludeArchived] = useState(true);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<TestcaseWorkspaceDetail | null>(null);
  const [moduleFilter, setModuleFilter] = useState<string>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<string>('ALL');
  const [compiling, setCompiling] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.testcaseWorkspaces({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(conversationFilter.trim()
          ? { conversationId: conversationFilter.trim() }
          : {}),
        ...(ownerFilter.trim() ? { ownerStaffId: ownerFilter.trim() } : {}),
        includeArchived,
        limit: 100,
      });
      setItems(res.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [query, conversationFilter, ownerFilter, includeArchived]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = async (id: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setModuleFilter('ALL');
    setPriorityFilter('ALL');
    try {
      const res = await api.testcaseWorkspaceDetail(id);
      setDetail({
        workspace: res.workspace,
        versions: res.versions,
        preview: res.preview,
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCompile = async (record: { id: string; revision: number }) => {
    setCompiling(true);
    try {
      const res = await api.compileTestcaseWorkspace(record.id, {
        baseRevision: record.revision,
      });
      message.success(`已合稿生成 v${res.document.version}`);
      await loadList();
      if (detail?.workspace.id === record.id) {
        await openDetail(record.id);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCompiling(false);
    }
  };

  const handleExport = async (
    workspaceId: string,
    format: TestcaseExportFormat,
    title: string,
    version?: number,
  ) => {
    try {
      await downloadTestcaseExport({
        workspaceId,
        format,
        ...(version !== undefined ? { version } : {}),
        fallbackName: title,
      });
      message.success(`已开始下载 ${format.toUpperCase()} 文件`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleArchived = async (
    id: string,
    revision: number,
    archived: boolean,
  ) => {
    try {
      await api.updateTestcaseWorkspace(id, { baseRevision: revision, archived });
      message.success(archived ? '已归档工作区' : '已取消归档');
      await loadList();
      if (detail?.workspace.id === id) {
        await openDetail(id);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleTogglePref = async (
    key: keyof TestcaseWorkspaceDetail['workspace']['state']['outputPreferences'],
    value: boolean,
  ) => {
    if (!detail) return;
    try {
      await api.updateTestcaseWorkspace(detail.workspace.id, {
        baseRevision: detail.workspace.revision,
        outputPreferences: { [key]: value },
      });
      await openDetail(detail.workspace.id);
      await loadList();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteTestcaseWorkspace(id);
      message.success('工作区已删除');
      if (detail?.workspace.id === id) {
        setDetailOpen(false);
        setDetail(null);
      }
      await loadList();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const modules = useMemo(() => {
    if (!detail) return [];
    return [...new Set(detail.preview.cases.map((item) => item.module))];
  }, [detail]);

  const filteredCases = useMemo(() => {
    if (!detail) return [];
    return detail.preview.cases.filter((item) => {
      if (moduleFilter !== 'ALL' && item.module !== moduleFilter) return false;
      if (priorityFilter !== 'ALL' && item.priority !== priorityFilter) return false;
      return true;
    });
  }, [detail, moduleFilter, priorityFilter]);

  const riskRows = useMemo(() => {
    if (!detail) return [];
    const coverage = new Map(
      (detail.preview.riskRegister ?? []).map((item) => [item.riskId, item]),
    );
    return detail.workspace.state.risks.map((risk) => ({
      ...risk,
      caseNumbers: coverage.get(risk.id)?.caseNumbers ?? [],
      covered: coverage.get(risk.id)?.covered ?? false,
    }));
  }, [detail]);

  const defectRows = useMemo(() => {
    if (!detail) return [];
    const coverage = new Map(
      (detail.preview.defectTraceability ?? []).map((item) => [
        item.defectId,
        item,
      ]),
    );
    return detail.workspace.state.defects.map((defect) => ({
      ...defect,
      caseNumbers: coverage.get(defect.id)?.caseNumbers ?? [],
      covered: coverage.get(defect.id)?.covered ?? false,
    }));
  }, [detail]);

  const execution = detail?.preview.execution;
  const executedCount = execution
    ? execution.passed + execution.failed + execution.blocked
    : 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜索工作区标题 / 项目"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onSearch={() => void loadList()}
              style={{ width: 220 }}
            />
            <Input
              allowClear
              placeholder="会话 ID 过滤"
              value={conversationFilter}
              onChange={(e) => setConversationFilter(e.target.value)}
              style={{ width: 170 }}
            />
            <Input
              allowClear
              placeholder="创建人 StaffId"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              style={{ width: 150 }}
            />
            <Space size={6}>
              <Typography.Text type="secondary">显示已归档</Typography.Text>
              <Switch checked={includeArchived} onChange={setIncludeArchived} size="small" />
            </Space>
          </Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void loadList()}
            loading={loading}
          >
            刷新
          </Button>
        </Space>
      </Card>

      <Card size="small" title={`测试用例工作区（${items.length}）`}>
        <Table<TestcaseWorkspaceSummary>
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={{ pageSize: 15 }}
          locale={{ emptyText: <Empty description="暂无测试用例工作区" /> }}
          columns={[
            {
              title: '工作区标题',
              dataIndex: 'title',
              render: (title: string, record) => (
                <Space size={6} wrap>
                  <Typography.Link onClick={() => void openDetail(record.id)}>
                    {title}
                  </Typography.Link>
                  {record.archived && <Tag>已归档</Tag>}
                  {record.projectId && <Tag color="geekblue">{record.projectId}</Tag>}
                </Space>
              ),
            },
            {
              title: '会话 / 创建人',
              key: 'owner',
              width: 220,
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text style={{ fontSize: 12 }}>
                    {record.ownerStaffId || '-'}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {record.conversationType === '2' ? '群聊' : '单聊'} ·{' '}
                    {record.conversationId || '-'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: '状态计数',
              key: 'counts',
              width: 240,
              render: (_, record) => (
                <Space size={4} wrap>
                  <Tag color="purple">r{record.revision}</Tag>
                  <Tag color="blue">需求 {record.requirementCount}</Tag>
                  <Tag color="green">用例 {record.caseCount}</Tag>
                  {record.openQuestionCount > 0 && (
                    <Tag color="orange">待确认 {record.openQuestionCount}</Tag>
                  )}
                  {(record.riskCount ?? 0) > 0 && (
                    <Tag color="volcano">风险 {record.riskCount}</Tag>
                  )}
                  {(record.defectCount ?? 0) > 0 && (
                    <Tag color="magenta">缺陷 {record.defectCount}</Tag>
                  )}
                </Space>
              ),
            },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              width: 170,
              render: (ts: number) => formatShanghaiDateTime(ts),
            },
            {
              title: '操作',
              key: 'actions',
              width: 280,
              render: (_, record) => (
                <Space size={4} wrap>
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    onClick={() => void openDetail(record.id)}
                  >
                    详情
                  </Button>
                  <Button
                    size="small"
                    icon={<CheckCircleOutlined />}
                    loading={compiling}
                    onClick={() => void handleCompile(record)}
                  >
                    合稿
                  </Button>
                  <Dropdown
                    menu={{
                      items: EXPORT_ITEMS,
                      onClick: ({ key }) =>
                        void handleExport(
                          record.id,
                          key as TestcaseExportFormat,
                          record.title,
                        ),
                    }}
                  >
                    <Button size="small" icon={<DownloadOutlined />}>
                      导出
                    </Button>
                  </Dropdown>
                  <Button
                    size="small"
                    onClick={() =>
                      void handleToggleArchived(
                        record.id,
                        record.revision,
                        !record.archived,
                      )
                    }
                  >
                    {record.archived ? '激活' : '归档'}
                  </Button>
                  <Popconfirm
                    title="确定删除该测试用例工作区及全部历史版本？"
                    onConfirm={() => void handleDelete(record.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={detail ? `${detail.workspace.title}（r${detail.workspace.revision}）` : '工作区详情'}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={1120}
        extra={
          detail && (
            <Space>
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                loading={compiling}
                onClick={() =>
                  void handleCompile({
                    id: detail.workspace.id,
                    revision: detail.workspace.revision,
                  })
                }
              >
                合稿新版本
              </Button>
              <Dropdown
                menu={{
                  items: EXPORT_ITEMS,
                  onClick: ({ key }) =>
                    void handleExport(
                      detail.workspace.id,
                      key as TestcaseExportFormat,
                      detail.workspace.title,
                    ),
                }}
              >
                <Button icon={<DownloadOutlined />}>导出文件</Button>
              </Dropdown>
            </Space>
          )
        }
      >
        {detailLoading || !detail ? (
          <Empty description={detailLoading ? '加载中…' : '未选择工作区'} />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small">
              <Space wrap size={16} style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space wrap>
                  <Tag color="blue">总用例 {detail.preview.statistics.total}</Tag>
                  <Tag color="red">高 {detail.preview.statistics.byPriority.高}</Tag>
                  <Tag color="orange">中 {detail.preview.statistics.byPriority.中}</Tag>
                  <Tag color="green">低 {detail.preview.statistics.byPriority.低}</Tag>
                  <Tag>版本数 {detail.versions.length}</Tag>
                  {detail.workspace.state.archived && <Tag color="default">已归档</Tag>}
                </Space>
                <Space wrap size={12}>
                  <Space size={4}>
                    <Typography.Text type="secondary">截图标记 📷</Typography.Text>
                    <Switch
                      size="small"
                      checked={detail.workspace.state.outputPreferences.screenshotMarkers}
                      onChange={(val) => void handleTogglePref('screenshotMarkers', val)}
                    />
                  </Space>
                  <Space size={4}>
                    <Typography.Text type="secondary">数据清单</Typography.Text>
                    <Switch
                      size="small"
                      checked={detail.workspace.state.outputPreferences.includeDataChecklist}
                      onChange={(val) => void handleTogglePref('includeDataChecklist', val)}
                    />
                  </Space>
                  <Space size={4}>
                    <Typography.Text type="secondary">需求追溯</Typography.Text>
                    <Switch
                      size="small"
                      checked={detail.workspace.state.outputPreferences.includeTraceability}
                      onChange={(val) => void handleTogglePref('includeTraceability', val)}
                    />
                  </Space>
                </Space>
              </Space>
            </Card>

            {detail.preview.issues.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`编译检查提醒（${detail.preview.issues.length} 项）`}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {detail.preview.issues.map((issue, idx) => (
                      <li key={`${issue.code}-${idx}`}>{issue.message}</li>
                    ))}
                  </ul>
                }
              />
            )}

            <Tabs
              items={[
                {
                  key: 'cases',
                  label: `七列用例预览（${detail.preview.cases.length}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Space wrap>
                        <Select
                          value={moduleFilter}
                          onChange={setModuleFilter}
                          style={{ width: 180 }}
                          options={[
                            { label: '全部模块', value: 'ALL' },
                            ...modules.map((m) => ({ label: m, value: m })),
                          ]}
                        />
                        <Select
                          value={priorityFilter}
                          onChange={setPriorityFilter}
                          style={{ width: 140 }}
                          options={[
                            { label: '全部优先级', value: 'ALL' },
                            { label: '高', value: '高' },
                            { label: '中', value: '中' },
                            { label: '低', value: '低' },
                          ]}
                        />
                      </Space>
                      <Table<CompiledTestcaseCase>
                        rowKey="id"
                        size="small"
                        dataSource={filteredCases}
                        pagination={{ pageSize: 12 }}
                        scroll={{ x: 960 }}
                        columns={[
                          { title: '用例编号', dataIndex: 'caseNumber', width: 130 },
                          { title: '用例标题', dataIndex: 'title', width: 180 },
                          {
                            title: '前置条件',
                            dataIndex: 'preconditions',
                            width: 180,
                            render: renderLines,
                          },
                          {
                            title: '操作步骤',
                            dataIndex: 'steps',
                            width: 240,
                            render: renderLines,
                          },
                          {
                            title: '预期结果',
                            dataIndex: 'expectedResults',
                            width: 210,
                            render: renderLines,
                          },
                          {
                            title: '优先级',
                            dataIndex: 'priority',
                            width: 75,
                            render: (p: '高' | '中' | '低') => (
                              <Tag color={PRIORITY_COLOR[p]}>{p}</Tag>
                            ),
                          },
                          { title: '测试方法', dataIndex: 'testMethod', width: 140 },
                          {
                            title: '执行状态',
                            dataIndex: 'execution',
                            width: 90,
                            render: (execution: CompiledTestcaseCase['execution']) => {
                              const status = execution?.status ?? 'untested';
                              return (
                                <Tag color={EXECUTION_COLOR[status]}>
                                  {EXECUTION_LABEL[status]}
                                </Tag>
                              );
                            },
                          },
                        ]}
                      />
                    </Space>
                  ),
                },
                {
                  key: 'traceability',
                  label: `需求追溯（${detail.preview.traceability.length}）`,
                  children: (
                    <Table
                      rowKey="requirementId"
                      size="small"
                      dataSource={detail.preview.traceability}
                      pagination={false}
                      columns={[
                        { title: '需求 ID', dataIndex: 'requirementId', width: 160 },
                        { title: '需求标题', dataIndex: 'title' },
                        {
                          title: '覆盖状态',
                          dataIndex: 'covered',
                          width: 100,
                          render: (covered: boolean) =>
                            covered ? (
                              <Tag color="green">已覆盖</Tag>
                            ) : (
                              <Tag color="red">未覆盖</Tag>
                            ),
                        },
                        {
                          title: '关联用例编号',
                          dataIndex: 'caseNumbers',
                          render: (nums: string[]) => nums.join('、') || '-',
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: 'risks',
                  label: `风险与缺陷（${riskRows.length} / ${defectRows.length}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Card size="small" title="需求评审风险">
                        <Table<TestcaseRisk & { caseNumbers: string[]; covered: boolean }>
                          rowKey="id"
                          size="small"
                          pagination={false}
                          dataSource={riskRows}
                          scroll={{ x: 1100 }}
                          columns={[
                            { title: '风险 ID', dataIndex: 'id', width: 150 },
                            { title: '模块', dataIndex: 'module', width: 120 },
                            { title: '风险标题', dataIndex: 'title', width: 200 },
                            {
                              title: '等级',
                              dataIndex: 'severity',
                              width: 70,
                              render: (severity: '高' | '中' | '低') => (
                                <Tag color={PRIORITY_COLOR[severity]}>{severity}</Tag>
                              ),
                            },
                            {
                              title: '状态',
                              dataIndex: 'status',
                              width: 90,
                              render: (status: TestcaseRisk['status']) =>
                                RISK_STATUS_LABEL[status],
                            },
                            { title: '风险说明', dataIndex: 'detail' },
                            { title: '应对说明', dataIndex: 'mitigation' },
                            {
                              title: '覆盖用例',
                              dataIndex: 'caseNumbers',
                              width: 170,
                              render: (nums: string[], row) =>
                                nums.length > 0 ? (
                                  nums.join('、')
                                ) : (
                                  <Tag color={row.status === 'open' ? 'red' : 'default'}>
                                    {row.status === 'open' ? '未覆盖' : '无需覆盖'}
                                  </Tag>
                                ),
                            },
                          ]}
                        />
                      </Card>
                      <Card size="small" title="缺陷复现追溯">
                        <Table<TestcaseDefect & { caseNumbers: string[]; covered: boolean }>
                          rowKey="id"
                          size="small"
                          pagination={false}
                          dataSource={defectRows}
                          scroll={{ x: 1100 }}
                          columns={[
                            { title: '缺陷 ID', dataIndex: 'id', width: 150 },
                            { title: '模块', dataIndex: 'module', width: 120 },
                            { title: '缺陷标题', dataIndex: 'title', width: 200 },
                            {
                              title: '等级',
                              dataIndex: 'severity',
                              width: 70,
                              render: (severity: '高' | '中' | '低') => (
                                <Tag color={PRIORITY_COLOR[severity]}>{severity}</Tag>
                              ),
                            },
                            {
                              title: '状态',
                              dataIndex: 'status',
                              width: 120,
                              render: (status: TestcaseDefect['status']) =>
                                DEFECT_STATUS_LABEL[status],
                            },
                            { title: '来源', dataIndex: 'sourceRef', width: 160 },
                            { title: '现象', dataIndex: 'symptom' },
                            {
                              title: '复现用例',
                              dataIndex: 'caseNumbers',
                              width: 170,
                              render: (nums: string[], row) =>
                                nums.length > 0 ? (
                                  nums.join('、')
                                ) : (
                                  <Tag
                                    color={
                                      row.status === 'open' || row.status === 'fixed'
                                        ? 'red'
                                        : 'default'
                                    }
                                  >
                                    缺少复现用例
                                  </Tag>
                                ),
                            },
                          ]}
                        />
                      </Card>
                    </Space>
                  ),
                },
                {
                  key: 'execution',
                  label: `执行与回归（${detail.preview.regression?.caseNumbers.length ?? 0}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Card size="small" title="执行结果汇总">
                        {execution ? (
                          <Space wrap size={12}>
                            <span>
                              已执行 {executedCount}/{execution.total}
                            </span>
                            <Tag color="green">通过 {execution.passed}</Tag>
                            <Tag color="red">失败 {execution.failed}</Tag>
                            <Tag color="orange">阻塞 {execution.blocked}</Tag>
                            <Tag>未执行 {execution.untested}</Tag>
                            <span>已执行通过率 {execution.passRate}%</span>
                          </Space>
                        ) : (
                          <Empty description="该合稿版本未记录执行统计" />
                        )}
                      </Card>
                      <Card size="small" title="回归范围建议">
                        <Table
                          rowKey="caseNumber"
                          size="small"
                          pagination={{ pageSize: 12 }}
                          dataSource={detail.preview.regression?.reasons ?? []}
                          columns={[
                            { title: '用例编号', dataIndex: 'caseNumber', width: 150 },
                            { title: '纳入原因', dataIndex: 'reason' },
                          ]}
                        />
                      </Card>
                    </Space>
                  ),
                },
                {
                  key: 'evidence',
                  label: `数据与证据决策（${detail.preview.dataItems.length} / ${detail.workspace.state.evidence.length}）`,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Card size="small" title="数据准备清单">
                        <Table
                          rowKey={(r) => `${r.module}-${r.placeholder}`}
                          size="small"
                          pagination={false}
                          dataSource={detail.preview.dataItems}
                          columns={[
                            { title: '模块', dataIndex: 'module', width: 140 },
                            { title: '占位符', dataIndex: 'placeholder' },
                            {
                              title: '关联用例',
                              dataIndex: 'caseNumbers',
                              render: (nums: string[]) => nums.join('、'),
                            },
                          ]}
                        />
                      </Card>
                      <Card size="small" title="证据记录">
                        <Table
                          rowKey="id"
                          size="small"
                          pagination={false}
                          dataSource={detail.workspace.state.evidence}
                          columns={[
                            { title: 'ID', dataIndex: 'id', width: 130 },
                            { title: '来源类型', dataIndex: 'type', width: 90 },
                            { title: '可信度', dataIndex: 'confidence', width: 80 },
                            { title: '摘要', dataIndex: 'summary' },
                            {
                              title: '冲突项',
                              dataIndex: 'conflictsWith',
                              width: 140,
                              render: (c: string[]) =>
                                c.length > 0 ? <Tag color="red">{c.join(', ')}</Tag> : '-',
                            },
                          ]}
                        />
                      </Card>
                      <Card size="small" title="已确认口径与待确认问题">
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          {detail.workspace.state.decisions.map((d) => (
                            <div key={d.id}>
                              <Tag color="green">已确认</Tag>
                              <Typography.Text strong>{d.topic}：</Typography.Text>
                              <Typography.Text>{d.value}</Typography.Text>
                            </div>
                          ))}
                          {detail.workspace.state.openQuestions.map((q) => (
                            <div key={q.id}>
                              <Tag color={q.blocking ? 'red' : 'orange'}>
                                {q.status === 'resolved'
                                  ? '已解决'
                                  : q.blocking
                                    ? '阻塞待确认'
                                    : '非阻塞待确认'}
                              </Tag>
                              <Typography.Text>{q.question}</Typography.Text>
                            </div>
                          ))}
                        </Space>
                      </Card>
                    </Space>
                  ),
                },
                {
                  key: 'markdown',
                  label: 'Markdown 原稿',
                  children: (
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Button
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => {
                          void navigator.clipboard?.writeText(detail.preview.markdown);
                          message.success('已复制 Markdown');
                        }}
                      >
                        复制全文
                      </Button>
                      <Input.TextArea
                        readOnly
                        rows={18}
                        value={detail.preview.markdown}
                        style={{ fontFamily: 'monospace' }}
                      />
                    </Space>
                  ),
                },
                {
                  key: 'versions',
                  label: `历史合稿版本（${detail.versions.length}）`,
                  children: (
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={false}
                      dataSource={detail.versions}
                      columns={[
                        {
                          title: '版本',
                          dataIndex: 'version',
                          width: 80,
                          render: (v: number) => <Tag color="blue">v{v}</Tag>,
                        },
                        {
                          title: '来源修订',
                          dataIndex: 'sourceRevision',
                          width: 90,
                          render: (r: number) => `r${r}`,
                        },
                        { title: '标签', dataIndex: 'label', render: (l?: string) => l || '-' },
                        {
                          title: '用例数',
                          render: (_, v) => v.document.statistics.total,
                          width: 80,
                        },
                        {
                          title: '合稿时间',
                          dataIndex: 'createdAt',
                          width: 170,
                          render: (ts: number) => formatShanghaiDateTime(ts),
                        },
                        {
                          title: '导出该版本',
                          key: 'exportVersion',
                          width: 120,
                          render: (_, v) => (
                            <Dropdown
                              menu={{
                                items: EXPORT_ITEMS,
                                onClick: ({ key }) =>
                                  void handleExport(
                                    detail.workspace.id,
                                    key as TestcaseExportFormat,
                                    detail.workspace.title,
                                    v.version,
                                  ),
                              }}
                            >
                              <Button size="small" icon={<DownloadOutlined />}>
                                下载 v{v.version}
                              </Button>
                            </Dropdown>
                          ),
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
