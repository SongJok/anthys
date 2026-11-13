import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import TracesPage, { renderStep } from './pages/TracesPage';

describe('web-console React components', () => {
  it('renders App shell with cookie-session auth status badge', () => {
    vi.stubGlobal('fetch', vi.fn());
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('钉钉智能体控制台');
    expect(html).toContain('检查会话中');
    expect(html).toContain('登录凭证');
  });

  it('renders TracesPage shell cleanly', () => {
    vi.stubGlobal('fetch', vi.fn());
    const html = renderToStaticMarkup(<TracesPage />);
    expect(html).toContain('ReAct 全链路轨迹');
    expect(html).toContain('按群 / 会话 ID 过滤');
  });

  it('renders subagent step tag and subTraces span breakdown', () => {
    const html = renderToStaticMarkup(
      renderStep({
        index: 0,
        type: 'subagent',
        toolName: 'delegate_research',
        durationMs: 450,
        output: '完成专题调研',
        subTraces: [
          {
            kind: 'subagent',
            name: 'delegate_research',
            steps: 2,
            tokens: 180,
            durationMs: 440,
          },
        ],
      }),
    );
    expect(html).toContain('子代理协作');
    expect(html).toContain('delegate_research');
    expect(html).toContain('subagent:delegate_research (2步 / 180t / 440ms)');
  });
});
