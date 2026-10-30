import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { api } from '../api';
import type { LLMConfig, LoopPolicy, LlmTestResult } from '../types';

interface FormValues {
  provider: LLMConfig['provider'];
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  enableNativeReasoning: boolean;
  personaName: string;
  rolePrompt: string;
  speakingStyle: string;
  maxWallTimeMs: number;
  maxTotalTokens: number;
  maxConsecutiveSameTool: number;
  convergenceCheck: boolean;
}

export default function LlmPersonaPage() {
  const [form] = Form.useForm<FormValues>();
  const [llm, setLlm] = useState<LLMConfig | null>(null);
  const [loop, setLoop] = useState<LoopPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [question, setQuestion] = useState('请用一句话介绍你自己。');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.llm();
      setLlm(result.llm);
      setLoop(result.loopPolicy);
      form.setFieldsValue({
        provider: result.llm.provider,
        baseUrl: result.llm.baseUrl,
        model: result.llm.model,
        apiKey: '',
        temperature: result.llm.temperature,
        enableNativeReasoning: result.llm.enableNativeReasoning,
        personaName: result.llm.persona.name,
        rolePrompt: result.llm.persona.rolePrompt,
        speakingStyle: result.llm.persona.speakingStyle,
        maxWallTimeMs: result.loopPolicy.maxWallTimeMs,
        maxTotalTokens: result.loopPolicy.maxTotalTokens,
        maxConsecutiveSameTool: result.loopPolicy.maxConsecutiveSameTool,
        convergenceCheck: result.loopPolicy.convergenceCheck,
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
      const result = await api.updateLlm({
        provider: values.provider,
        baseUrl: values.baseUrl.trim(),
        model: values.model.trim(),
        temperature: values.temperature,
        enableNativeReasoning: values.enableNativeReasoning,
        ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim() } : {}),
        persona: {
          name: values.personaName.trim(),
          rolePrompt: values.rolePrompt,
          speakingStyle: values.speakingStyle,
        },
        loop: {
          maxWallTimeMs: values.maxWallTimeMs,
          maxTotalTokens: values.maxTotalTokens,
          maxConsecutiveSameTool: values.maxConsecutiveSameTool,
          convergenceCheck: values.convergenceCheck,
        },
      });
      setLlm(result.llm);
      setLoop(result.loopPolicy);
      form.setFieldValue('apiKey', '');
      message.success('大模型与人设已热更新（无需重启）');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testLlm(question);
      setTestResult(result.result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="模型渠道与动态循环预算"
        className="console-card"
        loading={loading}
        extra={
          <Button type="primary" loading={saving} onClick={() => void form.submit()}>
            保存并热更新
          </Button>
        }
      >
        <Form form={form} layout="vertical" onFinish={save}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="修改后立即作用于正在运行的 ReAct 引擎与旁听分类器，无需重启进程。API Key 留空表示保持原值。"
          />
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="模型渠道" name="provider">
                <Select
                  options={[
                    { value: 'openai-compatible', label: 'OpenAI 兼容' },
                    { value: 'anthropic', label: 'Anthropic' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="Base URL"
                name="baseUrl"
                rules={[{ required: true, message: '请输入 Base URL' }]}
              >
                <Input placeholder="https://api.deepseek.com/v1" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="模型名称"
                name="model"
                rules={[{ required: true, message: '请输入模型名称' }]}
              >
                <Input placeholder="deepseek-reasoner" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="API Key（留空保持不变）" name="apiKey">
                <Input.Password
                  placeholder={llm ? `当前：${llm.apiKey}` : '请输入 API Key'}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="采样温度" name="temperature">
                <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="原生思维链"
                name="enableNativeReasoning"
                valuePropName="checked"
              >
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
            </Col>
          </Row>
          <Divider orientation="left">ReAct 循环预算</Divider>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="单轮最大耗时（ms）" name="maxWallTimeMs">
                <InputNumber min={1000} step={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="Token 上限" name="maxTotalTokens">
                <InputNumber min={1000} step={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="同一工具连续调用上限" name="maxConsecutiveSameTool">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="信息收敛自检"
                name="convergenceCheck"
                valuePropName="checked"
              >
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
            </Col>
          </Row>
          <Divider orientation="left">机器人人设</Divider>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="名称" name="personaName">
                <Input />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item label="说话风格" name="speakingStyle">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="人设 Prompt" name="rolePrompt">
            <Input.TextArea rows={5} />
          </Form.Item>
        </Form>
        {loop && (
          <Typography.Text type="secondary">
            当前生效预算：{loop.maxWallTimeMs} ms / {loop.maxTotalTokens} tokens
          </Typography.Text>
        )}
      </Card>

      <Card title="人设在线调试（沙盒对话）" className="console-card">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <Button type="primary" loading={testing} onClick={() => void runTest()}>
            发起测试
          </Button>
          {testResult && (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Card size="small" title="回答">
                {testResult.answer || '（无回答）'}
              </Card>
              {testResult.reasoning && (
                <Card size="small" title="原生思维链">
                  <div className="trace-reasoning">{testResult.reasoning}</div>
                </Card>
              )}
              <Typography.Text type="secondary">
                耗时 {testResult.usage.durationMs} ms · Token{' '}
                {testResult.usage.totalTokens}
              </Typography.Text>
            </Space>
          )}
        </Space>
      </Card>
    </Space>
  );
}
