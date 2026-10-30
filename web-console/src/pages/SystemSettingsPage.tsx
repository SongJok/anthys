import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { api } from '../api';
import type { DingTalkConfig, StreamStatus } from '../types';

interface FormValues {
  clientId: string;
  clientSecret?: string;
  robotCode: string;
  aiCardTemplateId: string;
  adminStaffIds: string[];
  dwsCliEnabled: boolean;
}

export default function SystemSettingsPage() {
  const [form] = Form.useForm<FormValues>();
  const [config, setConfig] = useState<DingTalkConfig | null>(null);
  const [stream, setStream] = useState<StreamStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.dingtalk();
      setConfig(result.config);
      setStream(result.stream);
      form.setFieldsValue({
        clientId: result.config.clientId,
        clientSecret: '',
        robotCode: result.config.robotCode,
        aiCardTemplateId: result.config.aiCardTemplateId,
        adminStaffIds: result.config.adminStaffIds,
        dwsCliEnabled: result.config.dwsCliEnabled,
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (values: FormValues) => {
    setSaving(true);
    try {
      const result = await api.updateDingtalk({
        clientId: values.clientId.trim(),
        robotCode: values.robotCode.trim(),
        aiCardTemplateId: values.aiCardTemplateId.trim(),
        adminStaffIds: values.adminStaffIds ?? [],
        dwsCliEnabled: values.dwsCliEnabled,
        ...(values.clientSecret?.trim()
          ? { clientSecret: values.clientSecret.trim() }
          : {}),
      });
      setConfig(result.config);
      setStream(result.stream);
      form.setFieldValue('clientSecret', '');
      message.success('钉钉配置已热更新，无需重启进程');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const sendTestCard = async () => {
    setTesting(true);
    try {
      const result = await api.testCard();
      if (result.ok) message.success('测试卡片已发送到管理员单聊');
      else message.error(result.error ?? '测试卡片发送失败');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card className="console-card">
        <Space size={12}>
          <Typography.Text strong>Stream 连接状态：</Typography.Text>
          {stream?.connected ? (
            <Tag color="green">已连接</Tag>
          ) : (
            <Tag color="red">未连接</Tag>
          )}
          {stream && !stream.connected && stream.detail && (
            <Typography.Text type="secondary">{stream.detail}</Typography.Text>
          )}
          <Button loading={testing} onClick={() => void sendTestCard()}>
            发送测试卡片
          </Button>
        </Space>
      </Card>

      <Card
        title="钉钉企业配置"
        className="console-card"
        loading={loading}
        extra={
          <Button type="primary" loading={saving} onClick={() => void form.submit()}>
            保存并热更新
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="AppSecret 不会回传明文：留空表示保持原值，填写新值将立即重建 Stream 客户端。"
        />
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item
            label="AppKey / ClientId"
            name="clientId"
            rules={[{ required: true, message: '请输入 AppKey' }]}
          >
            <Input placeholder="dingxxxxxxxx" />
          </Form.Item>
          <Form.Item label="AppSecret（留空保持不变）" name="clientSecret">
            <Input.Password
              placeholder={
                config ? `当前：${config.clientSecretMasked}` : '请输入 AppSecret'
              }
            />
          </Form.Item>
          <Form.Item
            label="RobotCode"
            name="robotCode"
            rules={[{ required: true, message: '请输入 RobotCode' }]}
          >
            <Input placeholder="dingxxxxxxxx" />
          </Form.Item>
          <Form.Item
            label="AI 流式卡片模板 ID"
            name="aiCardTemplateId"
            rules={[{ required: true, message: '请输入卡片模板 ID' }]}
          >
            <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </Form.Item>
          <Form.Item
            label="管理员 StaffId 白名单"
            name="adminStaffIds"
            extra="这里的名单会覆盖 .env 的 DINGTALK_ADMIN / ADMIN_STAFF_IDS；管理员可在机器人单聊中直接下达管控指令"
          >
            <Select
              mode="tags"
              tokenSeparators={[',', ' ']}
              placeholder="输入 StaffId 后回车"
            />
          </Form.Item>
          <Form.Item
            label="DWS CLI 权限开关"
            name="dwsCliEnabled"
            valuePropName="checked"
          >
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
        </Form>
      </Card>
    </Space>
  );
}
