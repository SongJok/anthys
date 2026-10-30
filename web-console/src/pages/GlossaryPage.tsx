import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { api } from '../api';
import type {
  GlossarySensitivity,
  GlossaryStats,
  GlossaryTerm,
  GlossaryTimeliness,
  GlossaryValidationReport,
} from '../types';

const TIMELINESS_OPTIONS: Array<{ value: GlossaryTimeliness; label: string }> = [
  { value: 'long_term', label: '长期' },
  { value: 'project', label: '项目期' },
  { value: 'retired', label: '已废弃' },
];

const SENSITIVITY_OPTIONS: Array<{ value: GlossarySensitivity; label: string }> = [
  { value: 'public', label: '公开' },
  { value: 'team', label: '团队内' },
  { value: 'sensitive', label: '敏感' },
];

const TIMELINESS_LABEL: Record<GlossaryTimeliness, string> = {
  long_term: '长期',
  project: '项目期',
  retired: '已废弃',
};

const SENSITIVITY_LABEL: Record<GlossarySensitivity, string> = {
  public: '公开',
  team: '团队内',
  sensitive: '敏感',
};

const TIMELINESS_COLOR: Record<GlossaryTimeliness, string> = {
  long_term: 'green',
  project: 'blue',
  retired: 'default',
};

const SENSITIVITY_COLOR: Record<GlossarySensitivity, string> = {
  public: 'green',
  team: 'gold',
  sensitive: 'red',
};

interface TermForm {
  standardName: string;
  aliases: string[];
  definition: string;
  usageScenarios: string;
  examples: string[];
  misconceptions: string;
  department: string;
  timeliness: GlossaryTimeliness;
  sensitivity: GlossarySensitivity;
  docLinks: string[];
  injectToPrompt: boolean;
  promptPriority: number;
}

interface Filters {
  query: string;
  timeliness?: GlossaryTimeliness;
  sensitivity?: GlossarySensitivity;
  onlyInjected: boolean;
  sort: 'updated' | 'hits' | 'priority';
}

const EMPTY_FILTERS: Filters = {
  query: '',
  onlyInjected: false,
  sort: 'updated',
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 与机器人注入、RAG 命中、工具返回完全一致的固定模板 */
function formatCard(term: GlossaryTerm): string {
  return [
    `【标准名称】${term.standardName}`,
    `【常见别名/缩写】${term.aliases.join('、') || '无'}`,
    `【定义】${term.definition || '无'}`,
    `【使用场景】${term.usageScenarios || '无'}`,
    `【示例句子】${
      term.examples.length > 0
        ? term.examples.map((item, index) => `${index + 1}. ${item}`).join('；')
        : '无'
    }`,
    `【不要误解为】${term.misconceptions || '无'}`,
    `【所属部门/项目】${term.department || '未标注'}`,
    `【时效性】${TIMELINESS_LABEL[term.timeliness]}`,
    `【敏感级别】${SENSITIVITY_LABEL[term.sensitivity]}`,
    `【关联文档链接】${term.docLinks.join(' ') || '无'}`,
    `【最后更新时间】${formatTime(term.lastUpdatedAt)}`,
  ].join('\n');
}

export default function GlossaryPage() {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<GlossaryStats | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);

  const [form] = Form.useForm<TermForm>();
  const [modal, setModal] = useState<{ open: boolean; editing?: GlossaryTerm }>({
    open: false,
  });
  const [report, setReport] = useState<GlossaryValidationReport | null>(null);
  const [preview, setPreview] = useState<{ prompt: string; count: number } | null>(
    null,
  );
  const [validating, setValidating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, statsResult] = await Promise.all([
        api.glossary({
          ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
          ...(filters.timeliness ? { timeliness: filters.timeliness } : {}),
          ...(filters.sensitivity ? { sensitivity: filters.sensitivity } : {}),
          ...(filters.onlyInjected ? { onlyInjected: true } : {}),
          sort: filters.sort,
          limit: 500,
        }),
        api.glossaryStats(),
      ]);
      setTerms(list.terms);
      setTotal(list.total);
      setStats(statsResult.stats);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setModal({ open: true });
    form.setFieldsValue({
      standardName: '',
      aliases: [],
      definition: '',
      usageScenarios: '',
      examples: [],
      misconceptions: '',
      department: '',
      timeliness: 'long_term',
      sensitivity: 'team',
      docLinks: [],
      injectToPrompt: true,
      promptPriority: 0,
    });
  };

  const openEdit = (term: GlossaryTerm) => {
    setModal({ open: true, editing: term });
    form.setFieldsValue({
      standardName: term.standardName,
      aliases: term.aliases,
      definition: term.definition,
      usageScenarios: term.usageScenarios,
      examples: term.examples,
      misconceptions: term.misconceptions,
      department: term.department,
      timeliness: term.timeliness,
      sensitivity: term.sensitivity,
      docLinks: term.docLinks,
      injectToPrompt: term.injectToPrompt,
      promptPriority: term.promptPriority,
    });
  };

  const submit = async (values: TermForm) => {
    const payload = {
      standardName: values.standardName.trim(),
      aliases: values.aliases ?? [],
      definition: values.definition.trim(),
      usageScenarios: values.usageScenarios?.trim() ?? '',
      examples: values.examples ?? [],
      misconceptions: values.misconceptions?.trim() ?? '',
      department: values.department?.trim() ?? '',
      timeliness: values.timeliness,
      sensitivity: values.sensitivity,
      docLinks: (values.docLinks ?? []).map((item) => item.trim()).filter(Boolean),
      injectToPrompt: values.injectToPrompt,
      promptPriority: values.promptPriority ?? 0,
    };
    try {
      if (modal.editing) {
        await api.updateGlossary(modal.editing.id, payload);
        message.success('术语已更新，缓存已失效');
      } else {
        await api.createGlossary(payload);
        message.success('术语已创建并立即参与检索');
      }
      setModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (term: GlossaryTerm) => {
    try {
      await api.deleteGlossary(term.id);
      message.success(`已删除「${term.standardName}」`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleInjection = async (term: GlossaryTerm, checked: boolean) => {
    try {
      await api.updateGlossary(term.id, { injectToPrompt: checked });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const runValidate = async () => {
    setValidating(true);
    try {
      const result = await api.glossaryValidate();
      setReport(result.report);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setValidating(false);
    }
  };

  const openPreview = async () => {
    try {
      const result = await api.glossaryPromptPreview();
      setPreview({ prompt: result.prompt, count: result.terms.length });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={4}>
          <Card className="console-card">
            <Statistic title="术语总数" value={stats?.total ?? 0} />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="console-card">
            <Statistic title="系统提示注入" value={stats?.injected ?? 0} />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="console-card">
            <Statistic title="敏感术语" value={stats?.sensitive ?? 0} />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="console-card">
            <Statistic title="已废弃" value={stats?.retired ?? 0} />
          </Card>
        </Col>
        <Col span={5}>
          <Card className="console-card">
            <Statistic title="缺定义" value={stats?.missingDefinition ?? 0} />
          </Card>
        </Col>
      </Row>

      <Card
        title="企业术语知识库（内部黑话）"
        className="console-card"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void load()}
              loading={loading}
            >
              刷新
            </Button>
            <Button
              icon={<SafetyOutlined />}
              loading={validating}
              onClick={() => void runValidate()}
            >
              质量校验
            </Button>
            <Button onClick={() => void openPreview()}>提示词预览</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增术语
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="术语会同时用于三处：① Top 高频术语注入系统提示；② 按提问检索术语卡；③ glossary_lookup 工具查询。敏感术语不会进入系统提示，群聊检索也会自动排除；已废弃术语不参与提示注入。"
        />

        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            allowClear
            placeholder="搜索标准名称 / 别名 / 定义"
            style={{ width: 280 }}
            value={filters.query}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, query: event.target.value }))
            }
            onSearch={(value) =>
              setFilters((prev) => ({ ...prev, query: value }))
            }
          />
          <Select
            allowClear
            placeholder="时效性"
            style={{ width: 140 }}
            options={TIMELINESS_OPTIONS}
            value={filters.timeliness}
            onChange={(value) =>
              setFilters((prev) => ({ ...prev, timeliness: value }))
            }
          />
          <Select
            allowClear
            placeholder="敏感级别"
            style={{ width: 140 }}
            options={SENSITIVITY_OPTIONS}
            value={filters.sensitivity}
            onChange={(value) =>
              setFilters((prev) => ({ ...prev, sensitivity: value }))
            }
          />
          <Select
            style={{ width: 150 }}
            value={filters.sort}
            options={[
              { value: 'updated', label: '按更新时间' },
              { value: 'hits', label: '按命中次数' },
              { value: 'priority', label: '按注入权重' },
            ]}
            onChange={(value) =>
              setFilters((prev) => ({ ...prev, sort: value }))
            }
          />
          <Space>
            <Typography.Text type="secondary">只看已注入</Typography.Text>
            <Switch
              checked={filters.onlyInjected}
              onChange={(checked) =>
                setFilters((prev) => ({ ...prev, onlyInjected: checked }))
              }
            />
          </Space>
          <Typography.Text type="secondary">共 {total} 条</Typography.Text>
        </Space>

        <Table<GlossaryTerm>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={terms}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (term) => (
              <pre
                style={{
                  background: '#f6f8ff',
                  padding: 12,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                }}
              >
                {formatCard(term)}
              </pre>
            ),
          }}
          columns={[
            {
              title: '标准名称 / 别名',
              key: 'name',
              width: 220,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{row.standardName}</Typography.Text>
                  {row.aliases.length > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {row.aliases.join('、')}
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: '定义',
              dataIndex: 'definition',
              ellipsis: true,
              render: (value: string) =>
                value || <Typography.Text type="danger">缺少定义</Typography.Text>,
            },
            {
              title: '部门 / 项目',
              dataIndex: 'department',
              width: 140,
              ellipsis: true,
              render: (value: string) => value || '未标注',
            },
            {
              title: '时效性',
              dataIndex: 'timeliness',
              width: 100,
              render: (value: GlossaryTimeliness) => (
                <Tag color={TIMELINESS_COLOR[value]}>
                  {TIMELINESS_LABEL[value]}
                </Tag>
              ),
            },
            {
              title: '敏感级别',
              dataIndex: 'sensitivity',
              width: 100,
              render: (value: GlossarySensitivity) => (
                <Tag color={SENSITIVITY_COLOR[value]}>
                  {SENSITIVITY_LABEL[value]}
                </Tag>
              ),
            },
            {
              title: '注入提示',
              key: 'inject',
              width: 100,
              render: (_, row) => (
                <Switch
                  size="small"
                  checked={row.injectToPrompt}
                  disabled={row.timeliness === 'retired' || row.sensitivity === 'sensitive'}
                  onChange={(checked) => void toggleInjection(row, checked)}
                />
              ),
            },
            {
              title: '命中',
              dataIndex: 'hitCount',
              width: 70,
            },
            {
              title: '最后更新',
              dataIndex: 'lastUpdatedAt',
              width: 170,
              render: (value: number) => formatTime(value),
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
                    title={`删除「${row.standardName}」？`}
                    description="删除后机器人将立即查不到该术语。"
                    onConfirm={() => void remove(row)}
                  >
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

      <Modal
        title={modal.editing ? `编辑术语：${modal.editing.standardName}` : '新增术语'}
        open={modal.open}
        onCancel={() => setModal({ open: false })}
        onOk={() => void form.submit()}
        okText="保存"
        width={720}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item
              label="标准名称"
              name="standardName"
              rules={[{ required: true, message: '请填写标准名称' }]}
              style={{ width: 320 }}
            >
              <Input placeholder="例如：双十一大促" />
            </Form.Item>
            <Form.Item label="所属部门 / 项目" name="department" style={{ width: 320 }}>
              <Input placeholder="例如：交易中台 / 2026 大促项目" />
            </Form.Item>
          </Space>
          <Form.Item label="常见别名 / 缩写" name="aliases">
            <Select mode="tags" placeholder="输入别名后回车，例如：11.11、双 11" />
          </Form.Item>
          <Form.Item
            label="定义"
            name="definition"
            rules={[{ required: true, message: '请填写定义，机器人依赖它理解术语' }]}
          >
            <Input.TextArea rows={3} placeholder="一句话说明它到底是什么" />
          </Form.Item>
          <Form.Item label="使用场景" name="usageScenarios">
            <Input.TextArea rows={2} placeholder="什么情况下会提到它" />
          </Form.Item>
          <Form.Item label="示例句子" name="examples">
            <Select mode="tags" placeholder="输入示例句子后回车" />
          </Form.Item>
          <Form.Item label="不要误解为" name="misconceptions">
            <Input.TextArea rows={2} placeholder="最容易混淆或误读的含义" />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item label="时效性" name="timeliness">
              <Select style={{ width: 160 }} options={TIMELINESS_OPTIONS} />
            </Form.Item>
            <Form.Item label="敏感级别" name="sensitivity">
              <Select style={{ width: 160 }} options={SENSITIVITY_OPTIONS} />
            </Form.Item>
            <Form.Item label="注入权重（0-100）" name="promptPriority">
              <InputNumber min={0} max={100} />
            </Form.Item>
            <Form.Item label="加入系统提示" name="injectToPrompt" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item label="关联文档链接" name="docLinks">
            <Select mode="tags" placeholder="https://..." />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="术语质量校验"
        open={Boolean(report)}
        footer={null}
        onCancel={() => setReport(null)}
        width={820}
      >
        {report && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space>
              <Tag>检查 {report.checked} 条</Tag>
              <Tag color="red">错误 {report.errors}</Tag>
              <Tag color="orange">警告 {report.warnings}</Tag>
              <Tag color="blue">提示 {report.infos}</Tag>
            </Space>
            {report.issues.length === 0 ? (
              <Alert type="success" showIcon message="全部通过，没有发现问题" />
            ) : (
              <Table
                rowKey={(row) => `${row.termId}-${row.field}-${row.message}`}
                size="small"
                pagination={{ pageSize: 10 }}
                dataSource={report.issues}
                columns={[
                  { title: '术语', dataIndex: 'standardName', width: 160 },
                  {
                    title: '级别',
                    dataIndex: 'severity',
                    width: 80,
                    render: (value: string) => (
                      <Tag
                        color={
                          value === 'error'
                            ? 'red'
                            : value === 'warning'
                              ? 'orange'
                              : 'blue'
                        }
                      >
                        {value}
                      </Tag>
                    ),
                  },
                  { title: '字段', dataIndex: 'field', width: 120 },
                  { title: '说明', dataIndex: 'message' },
                ]}
              />
            )}
          </Space>
        )}
      </Modal>

      <Modal
        title={`系统提示注入预览（${preview?.count ?? 0} 条）`}
        open={Boolean(preview)}
        footer={null}
        onCancel={() => setPreview(null)}
        width={860}
      >
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="说明">
            这是每轮对话实际拼接进系统提示的术语段落，已排除敏感与已废弃术语。
          </Descriptions.Item>
        </Descriptions>
        <pre
          style={{
            background: '#f6f8ff',
            padding: 12,
            margin: 0,
            maxHeight: 480,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            fontSize: 12,
          }}
        >
          {preview?.prompt || '当前没有可注入的术语'}
        </pre>
      </Modal>
    </Space>
  );
}
