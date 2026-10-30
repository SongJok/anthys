import { useState } from 'react';
import {
  Button,
  Input,
  Layout,
  Menu,
  Modal,
  Space,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  BranchesOutlined,
  DashboardOutlined,
  RobotOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { getToken, setToken } from './api';
import DashboardPage from './pages/DashboardPage';
import SystemSettingsPage from './pages/SystemSettingsPage';
import LlmPersonaPage from './pages/LlmPersonaPage';
import McpConfigPage from './pages/McpConfigPage';
import GroupsPage from './pages/GroupsPage';
import TracesPage from './pages/TracesPage';

const { Header, Sider, Content } = Layout;

const MENU = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '运行大盘' },
  { key: 'dingtalk', icon: <SettingOutlined />, label: '钉钉企业配置' },
  { key: 'llm', icon: <RobotOutlined />, label: '大模型与人设' },
  { key: 'mcp', icon: <ApiOutlined />, label: '企业 MCP' },
  { key: 'groups', icon: <TeamOutlined />, label: '群聊旁听策略' },
  { key: 'traces', icon: <BranchesOutlined />, label: 'ReAct 审计轨迹' },
];

const PAGE_TITLES: Record<string, string> = {
  dashboard: '运行大盘',
  dingtalk: '钉钉企业配置',
  llm: '大模型与人设配置',
  mcp: '企业内部 MCP 配置',
  groups: '群聊旁听与主动回复策略',
  traces: 'ReAct 全链路审计',
};

export default function App() {
  const [active, setActive] = useState('dashboard');
  const [tokenModalOpen, setTokenModalOpen] = useState(!getToken());
  const [tokenDraft, setTokenDraft] = useState(getToken());

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} className="console-sider">
        <div style={{ padding: '20px 20px 12px' }} className="console-logo">
          钉钉智能体控制台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[active]}
          items={MENU}
          onClick={(info) => setActive(info.key)}
          style={{ background: 'transparent' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #eef1f5',
          }}
        >
          <Typography.Title level={5} style={{ margin: 0 }}>
            {PAGE_TITLES[active]}
          </Typography.Title>
          <Space>
            <Typography.Text type="secondary">
              管理 API Token
            </Typography.Text>
            <Button size="small" onClick={() => setTokenModalOpen(true)}>
              {getToken() ? '已配置' : '未配置'}
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
          {active === 'dashboard' && <DashboardPage />}
          {active === 'dingtalk' && <SystemSettingsPage />}
          {active === 'llm' && <LlmPersonaPage />}
          {active === 'mcp' && <McpConfigPage />}
          {active === 'groups' && <GroupsPage />}
          {active === 'traces' && <TracesPage />}
        </Content>
      </Layout>

      <Modal
        title="设置管理 API Token"
        open={tokenModalOpen}
        onCancel={() => setTokenModalOpen(Boolean(getToken()))}
        onOk={() => {
          setToken(tokenDraft.trim());
          setTokenModalOpen(false);
          message.success('Token 已保存');
          window.location.reload();
        }}
        okText="保存"
        cancelText="稍后"
      >
        <Typography.Paragraph type="secondary">
          Token 对应服务端环境变量 ADMIN_API_TOKEN，保存在浏览器本地。
        </Typography.Paragraph>
        <Input.Password
          placeholder="请输入 ADMIN_API_TOKEN"
          value={tokenDraft}
          onChange={(event) => setTokenDraft(event.target.value)}
        />
      </Modal>
    </Layout>
  );
}
