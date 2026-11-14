import { describe, expect, it, vi } from 'vitest';
import { runTurnWithAsyncHandoff } from './AsyncTurnHandoff.js';

describe('runTurnWithAsyncHandoff', () => {
  it('completes in foreground when faster than threshold', async () => {
    const enqueueBackground = vi.fn(async () => ({ id: 'job-1' }));
    const onHandoff = vi.fn();
    const outcome = await runTurnWithAsyncHandoff({
      handoffAfterMs: 500,
      runForeground: async () => '快速答复',
      enqueueBackground,
      onHandoff,
    });
    expect(outcome).toEqual({ mode: 'foreground', result: '快速答复' });
    expect(enqueueBackground).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it('aborts foreground and enqueues background job after handoffAfterMs when no side effects occurred', async () => {
    let fgAborted = false;
    const enqueueBackground = vi.fn(async () => ({ id: 'job-async-1' }));
    const onHandoff = vi.fn();

    const outcome = await runTurnWithAsyncHandoff({
      handoffAfterMs: 25,
      hasSideEffects: () => false,
      runForeground: async (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            fgAborted = true;
            reject(new Error('aborted'));
          });
        }),
      enqueueBackground,
      onHandoff,
    });

    expect(outcome).toEqual({ mode: 'background', job: { id: 'job-async-1' } });
    expect(fgAborted).toBe(true);
    expect(enqueueBackground).toHaveBeenCalledTimes(1);
    expect(onHandoff).toHaveBeenCalledWith({ id: 'job-async-1' });
  });

  it('does not abort or re-enqueue when mutating side effects already ran', async () => {
    const enqueueBackground = vi.fn(async () => ({ id: 'job-2' }));
    const outcome = await runTurnWithAsyncHandoff({
      handoffAfterMs: 15,
      hasSideEffects: () => true,
      runForeground: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return '副作用操作已完成';
      },
      enqueueBackground,
    });

    expect(outcome).toEqual({ mode: 'foreground', result: '副作用操作已完成' });
    expect(enqueueBackground).not.toHaveBeenCalled();
  });

  it('runs straight in foreground when handoffAfterMs <= 0', async () => {
    const enqueueBackground = vi.fn();
    const outcome = await runTurnWithAsyncHandoff({
      handoffAfterMs: 0,
      runForeground: async () => 42,
      enqueueBackground,
    });
    expect(outcome).toEqual({ mode: 'foreground', result: 42 });
    expect(enqueueBackground).not.toHaveBeenCalled();
  });

  it('入队后外部 /stop 中止时撤销后台任务并以中止原因拒绝', async () => {
    const controller = new AbortController();
    const cancelBackground = vi.fn(async () => {});
    const onHandoff = vi.fn();
    const enqueueBackground = vi.fn(async () => {
      // 入队过程中用户触发 /stop
      controller.abort(new Error('用户停止'));
      return { id: 'job-stop' };
    });
    const runForeground = async (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('fg aborted')));
      });

    await expect(
      runTurnWithAsyncHandoff({
        handoffAfterMs: 15,
        signal: controller.signal,
        hasSideEffects: () => false,
        runForeground,
        enqueueBackground,
        cancelBackground,
        onHandoff,
      }),
    ).rejects.toThrow('用户停止');

    expect(enqueueBackground).toHaveBeenCalledTimes(1);
    expect(cancelBackground).toHaveBeenCalledWith({ id: 'job-stop' });
    expect(onHandoff).not.toHaveBeenCalled();
  });

  it('转入后台前等待前台协作式中止真正收敛后再释放', async () => {
    let fgSettled = false;
    const enqueueBackground = vi.fn(async () => ({ id: 'job-conv' }));
    const runForeground = async (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          // 协作式中止需要一点时间才收敛
          setTimeout(() => {
            fgSettled = true;
            reject(new Error('fg aborted'));
          }, 20);
        });
      });

    const outcome = await runTurnWithAsyncHandoff({
      handoffAfterMs: 10,
      hasSideEffects: () => false,
      runForeground,
      enqueueBackground,
    });

    expect(outcome).toEqual({ mode: 'background', job: { id: 'job-conv' } });
    expect(fgSettled).toBe(true);
  });
});
