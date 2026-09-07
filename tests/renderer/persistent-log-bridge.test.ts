/**
 * persistent-log-bridge.ts 单测（自动保存方案 S4，测试矩阵 §16.5 LG-02~05/23 对应项）。
 * 覆盖：
 *  - LG-02 debug off：普通 info 不采集
 *  - LG-03 debug on：批量落盘（阈值/时间触发）
 *  - LG-04 warn 立即发送
 *  - LG-05 error 立即发送并 flush
 *  - LG-23 console 包装不递归（IPC 失败只计数不抛）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersistentLogBridge, BATCH_THRESHOLD, BATCH_DELAY_MS } from '@renderer/lib/persistent-log-bridge';

type AppendArgs = { entries: unknown[]; flush: boolean };

describe('PersistentLogBridge', () => {
  let bridge: PersistentLogBridge;
  let appendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appendMock = vi.fn(async (_args: AppendArgs) => ({ accepted: 1, dropped: 0 }));
    (window as unknown as { sqlStudio: Record<string, unknown> }).sqlStudio = {
      'logs:append': appendMock,
    };
    bridge = new PersistentLogBridge({ batchDelayMs: 50 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    bridge.stop();
  });

  function makeEntry(level: 'log' | 'info' | 'warn' | 'error', message: string) {
    return { time: new Date().toISOString(), level, message };
  }

  it('LG-02 debug off：普通 info 不发送', async () => {
    bridge.setDebugMode(false);
    bridge.push(makeEntry('info', '普通信息'));
    bridge.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('LG-03 debug on：批量阈值触发（20 条）', async () => {
    bridge.setDebugMode(true);
    for (let i = 0; i < BATCH_THRESHOLD; i++) {
      bridge.push(makeEntry('info', `info-${i}`));
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(appendMock).toHaveBeenCalledTimes(1);
    const args = appendMock.mock.calls[0]![0] as AppendArgs;
    expect(args.entries).toHaveLength(BATCH_THRESHOLD);
    expect(args.flush).toBe(false);
  });

  it('LG-03b debug on：时间阈值触发（250ms）', async () => {
    bridge.setDebugMode(true);
    bridge.push(makeEntry('info', 'single'));
    await vi.advanceTimersByTimeAsync(BATCH_DELAY_MS + 20);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('LG-04 warn 立即发送', async () => {
    bridge.setDebugMode(false); // warn 不受 debugMode 开关影响
    bridge.push(makeEntry('warn', '告警'));
    await vi.advanceTimersByTimeAsync(10);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('LG-05 error 立即发送并 flush', async () => {
    bridge.push(makeEntry('error', '错误'));
    await vi.advanceTimersByTimeAsync(10);
    expect(appendMock).toHaveBeenCalledTimes(1);
    const args = appendMock.mock.calls[0]![0] as AppendArgs;
    expect(args.flush).toBe(true);
  });

  it('LG-23 IPC 失败只计数不递归（不抛、不影响后续）', async () => {
    bridge.setDebugMode(true);
    appendMock.mockRejectedValueOnce(new Error('ipc down'));
    bridge.push(makeEntry('error', 'E1'));
    await vi.advanceTimersByTimeAsync(20);
    expect(bridge.getDroppedCount()).toBe(1);
    // 后续正常发送
    bridge.push(makeEntry('warn', 'W2'));
    await vi.advanceTimersByTimeAsync(20);
    expect(appendMock).toHaveBeenCalledTimes(2);
  });

  it('stop 后不再发送', async () => {
    bridge.setDebugMode(true);
    bridge.stop();
    bridge.push(makeEntry('info', 'after-stop'));
    await vi.advanceTimersByTimeAsync(200);
    expect(appendMock).not.toHaveBeenCalled();
  });
});