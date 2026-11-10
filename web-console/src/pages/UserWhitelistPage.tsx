import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { formatShanghaiDateTime } from '../time';
import type {
  WhitelistEntry,
  WhitelistSource,
  WhitelistStats,
  WhitelistStatus,
} from '../types';

const STATUS_LABELS: Record<WhitelistStatus, string> = {
  pending: '待授权',
  approved: '已授权',
  rejected: '已拒绝',
  left: '已离职',
};

const STATUS_COLORS: Record<WhitelistStatus, string> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
  left: 'default',
};

const SOURCE_LABELS: Record<WhitelistSource, string> = {
  directory: '通讯录同步',
  dws: 'DWS 通讯录',
  auto: '首次交互登记',
  manual: '手动录入',
};

type StatusFilter = WhitelistStatus | 'all';

const EMPTY_STATS: WhitelistStats = {
  total: 0,
  pending: 0,
  approved: 0,
  rejected: 0,
  left: 0,
  syncedAt: null,
};

export default function UserWhitelistPage() {
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<WhitelistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<WhitelistStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.whitelist({
        ...(status === 'all' ? {} : { status }),
        ...(query.trim() ? { query } : {}),
        page,
        pageSize,
      });
      setItems(result.items);
      setTotal(result.total);
      setStats(result.stats);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, query, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { result } = await api.syncWhitelist();
      message.success(
        `已从 ${result.source === 'dws' ? 'DWS 通讯录' : '钉钉通讯录'} 同步 ${result.scanned} 人：新增 ${result.created}、更新 ${result.updated}、无变化 ${result.unchanged}、标记离职 ${result.left}`,
      );
      if (result.warnings.length > 0) {
        message.warning(result.warnings.join('；'));
      }
      setSelected([]);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  };

  const updateOne = async (entry: WhitelistEntry, next: WhitelistStatus) => {
    setActing(true);
    try {
      await api.updateWhitelist(entry.staffId, { status: next });
      message.success(`${entry.name || entry.staffId} 已${STATUS_LABELS[next]}`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActing(false);
    }
  };

  const updateBatch = async (next: WhitelistStatus) => {
    if (selected.length === 0) return;
    setActing(true);
    try {
      const { updated } = await api.batchWhitelist({
        staffIds: selected,
        status: next,
      });
      message.success(`已批量${STATUS_LABELS[next]} ${updated} 人`);
      setSelected([]);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActing(false);
    }
  };

  const columns = [
    {
      title: '员工',
      key: 'person',
      width: 220,
      render: (_: unknown, row: WhitelistEntry) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.name || '未命名'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.staffId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '部门',
      dataIndex: 'deptPath',
      ellipsis: true,
      render: (value: string) => value || '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: WhitelistStatus) => (
        <Tag color={STATUS_COLORS[value]}>{STATUS_LABELS[value]}</Tag>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: WhitelistSource) => <Tag>{SOURCE_LABELS[value]}</Tag>,
    },
    {
      title: '授权人',
      key: 'approved',
      width: 160,
      render: (_: unknown, row: WhitelistEntry) =>
        row.approvedBy ? (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>
              {row.approvedBy}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatShanghaiDateTime(row.approvedAt)}
            </Typography.Text>
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: '最近同步',
      dataIndex: 'lastSeenAt',
      width: 170,
      render: (value: string | null) => formatShanghaiDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_: unknown, row: WhitelistEntry) => (
        <Space size={4}>
          {row.status !== 'approved' && (
            <Popconfirm
              title="授权该员工使用机器人？"
              description="授权后该员工在单聊、群聊与卡片回调中均可正常使用。"
              onConfirm={() => void updateOne(row, 'approved')}
            >
              <Button size="small" type="primary" ghost loading={acting}>
                通过
              </Button>
            </Popconfirm>
          )}
          {row.status !== 'rejected' && (
            <Popconfirm
              title="拒绝该员工使用机器人？"
              description="拒绝后该员工的所有消息与卡片操作都会被忽略。"
              onConfirm={() => void updateOne(row, 'rejected')}
            >
              <Button size="small" danger loading={acting}>
                拒绝
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message="外部人员一律拒绝：非本组织员工（openDingTalkId 无法解析为 staffId）无论是否点击卡片都不会获得任何回复。未授权的内部员工消息不会写入记忆、不会触发旁听，也不会调用任何工具。管理员不受白名单限制。同步通讯录时，通讯录里已不存在的员工会被标记为「已离职」并停止放行，重新入职后自动回到待授权。"
      />

      <Row gutter={16}>
        <Col span={4}>
          <Card className="console-card">
            <Statistic title="通讯录总人数" value={stats.total} />
          </Card>
        </Col>
        <Col span={4}>
          <Card className="console-card">
            <Statistic
              title="待授权"
              value={stats.pending}
              valueStyle={{ color: '#d46b08' }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card className="console-card">
            <Statistic
              title="已授权"
              value={stats.approved}
              valueStyle={{ color: '#389e0d' }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card className="console-card">
            <Statistic
              title="已拒绝"
              value={stats.rejected}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card className="console-card">
            <Statistic title="已离职" value={stats.left} />
          </Card>
        </Col>
        <Col span={4}>
          <Card className="console-card">
            <Statistic
              title="最近同步"
              value={formatShanghaiDateTime(stats.syncedAt)}
              valueStyle={{ fontSize: 16 }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="员工使用白名单"
        className="console-card"
        extra={
          <Space>
            <Segmented
              value={status}
              options={[
                { value: 'pending', label: '待授权' },
                { value: 'approved', label: '已授权' },
                { value: 'rejected', label: '已拒绝' },
                { value: 'left', label: '已离职' },
                { value: 'all', label: '全部' },
              ]}
              onChange={(value) => {
                setStatus(value as StatusFilter);
                setPage(1);
                setSelected([]);
              }}
            />
            <Input.Search
              allowClear
              placeholder="搜索姓名 / staffId / 部门"
              style={{ width: 240 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onSearch={() => {
                setPage(1);
                setSelected([]);
              }}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void load()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<SyncOutlined />}
              loading={syncing}
              onClick={() => void sync()}
            >
              同步通讯录
            </Button>
          </Space>
        }
      >
        {selected.length > 0 && (
          <Space style={{ marginBottom: 12 }}>
            <Typography.Text>已选 {selected.length} 人</Typography.Text>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              loading={acting}
              onClick={() => void updateBatch('approved')}
            >
              批量通过
            </Button>
            <Button
              size="small"
              danger
              icon={<CloseOutlined />}
              loading={acting}
              onClick={() => void updateBatch('rejected')}
            >
              批量拒绝
            </Button>
            <Button size="small" onClick={() => setSelected([])}>
              取消选择
            </Button>
          </Space>
        )}
        <Table<WhitelistEntry>
          rowKey="staffId"
          size="small"
          loading={loading}
          dataSource={items}
          columns={columns}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(String)),
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 人`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText:
              status === 'pending'
                ? '暂无待授权员工，点击「同步通讯录」拉取组织成员'
                : '暂无数据',
          }}
        />
      </Card>
    </Space>
  );
}
