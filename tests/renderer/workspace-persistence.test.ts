/**
 * workspace-persistence.ts 调度测试（自动保存方案 S3，测试矩阵 §16.3）。
 * 覆盖：500ms 防抖（RD-01）、latest-wins（RD-02/RD-03）、结构事件立即保存（RD-04~07）、
 * 重试（RD-08/RD-09）、flush（RD-10/RD-11）、hydrate 屏障（RD-12）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkspacePersistenceCoordinator,
  buildSnapshotFromSource,
  CONTENT_DEBOUNCE_MS,
  RETRY_DELAYS,
  type WorkspacePersistenceDeps,
} from '@renderer/lib/workspace-persistence';
import type {
  WorkspaceLoadResult,
  WorkspaceSaveResult,
} from '@shared/types';
import { WORKSPACE_SCHEMA_VERSION } from '@shared/types';

function makeSource() {
  return {
    activeTabId: 't1',
    currentConnectionId: null,
    tabs: [
      { id: 't1', title: '查询1', sql: 'SELECT 1', isDirty: true },
    ],
  };
}

interface SaveCall {
  revision: number;
  sql: string;
}

function makeCoordinator(overrides: Partial<WorkspacePersistenceDeps> = {}) {
  const saveCalls: SaveCall[] = [];
  const saveMock = vi.fn(async (req: { snapshot: { revision: number; tabs: { sqlContent: string }[] } }): Promise<WorkspaceSaveResult> => {
    saveCalls.push({ revision: req.snapshot.revision, sql: req.snapshot.tabs[0]?.sqlContent ?? '' });
    return { saved: true, acceptedRevision: req.snapshot.revision, storedRevision: req.snapshot.revision, reason: 'saved' };
  });
  const loadResult: WorkspaceLoadResult = {
    snapshot: null,
    recoveredTabCount: 0,
    quarantinedTabCount: 0,
    warnings: [],
  };
  const deps: WorkspacePersistenceDeps = {
    buildSnapshot: () => buildSnapshotFromSource(makeSource()),
    save: saveMock as never,
    load: vi.fn(async () => loadResult),
    // 测试注入确定性重试延迟（避免 jitter 随机性）
    retryDelayMs: (attempt) => RETRY_DELAYS[attempt - 1] ?? 1000,
    ...overrides,
  };
  const coordinator = new WorkspacePersistenceCoordinator(deps);
  return { coordinator, saveMock, saveCalls, deps };
}

describe('自动保存调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('RD-01 单次输入：500ms 后保存一次', async () => {
    const { coordinator, saveMock } = makeCoordinator();
    await coordinator.start();
    coordinator.resume();

    coordinator.onContentChanged();
    expect(saveMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS - 1);
    expect(saveMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('RD-02 连续快速输入：只保存最新快照（latest-wins）', async () => {
    const { coordinator, saveMock, saveCalls } = makeCoordinator();
    await coordinator.start();
    coordinator.resume();

    // 连续 3 次输入，防抖重置，最终只保存一次
    coordinator.onContentChanged();
    coordinator.onContentChanged();
    coordinator.onContentChanged();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 10);
    expect(saveMock).toHaveBeenCalledTimes(1);
    // 第一次输入后再次输入（防抖已触发后）→ 新一轮
    coordinator.onContentChanged();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 10);
    expect(saveMock).toHaveBeenCalledTimes(2);
    // revision 单调递增
    expect(saveCalls[0]!.revision).toBe(1);
    expect(saveCalls[1]!.revision).toBe(2);
  });

  it('RD-03 保存中继续输入：完成后保存最新 generation', async () => {
    const revisions: number[] = [];
    let releaseFirst: (() => void) | undefined;
    let callCount = 0;
    const saveMock = vi.fn((req: { snapshot: { revision: number } }) => {
      callCount += 1;
      revisions.push(req.snapshot.revision);
      return new Promise<WorkspaceSaveResult>((resolve) => {
        if (callCount === 1) {
          releaseFirst = () => resolve({ saved: true, acceptedRevision: req.snapshot.revision, storedRevision: req.snapshot.revision, reason: 'saved' });
        } else {
          resolve({ saved: true, acceptedRevision: req.snapshot.revision, storedRevision: req.snapshot.revision, reason: 'saved' });
        }
      });
    });
    const { coordinator } = makeCoordinator({ save: saveMock as never });
    await coordinator.start();
    coordinator.resume();

    coordinator.onContentChanged();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 10); // 第一次保存开始（挂起）
    expect(saveMock).toHaveBeenCalledTimes(1);
    // 保存期间状态又变化（内容事件：重置 500ms 防抖）
    coordinator.onContentChanged();
    await vi.advanceTimersByTimeAsync(50);
    expect(saveMock).toHaveBeenCalledTimes(1); // 仍在途，不并发
    releaseFirst?.();
    // 第一次完成 → persistedGeneration < generation → 等防抖到期后立即保存最新
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 20);
    expect(saveMock).toHaveBeenCalledTimes(2); // 完成后立即保存最新
    expect(revisions[1]!).toBeGreaterThan(revisions[0]!);
  });

  it('RD-04/05/06/07 结构事件立即排队（不等待防抖）', async () => {
    const { coordinator, saveMock } = makeCoordinator();
    await coordinator.start();
    coordinator.resume();

    coordinator.onStructuralChanged(); // 新建
    await vi.advanceTimersByTimeAsync(10);
    expect(saveMock).toHaveBeenCalledTimes(1);

    coordinator.onStructuralChanged(); // 切换
    await vi.advanceTimersByTimeAsync(10);
    expect(saveMock).toHaveBeenCalledTimes(2);

    coordinator.onStructuralChanged(); // 关闭
    await vi.advanceTimersByTimeAsync(10);
    expect(saveMock).toHaveBeenCalledTimes(3);

    coordinator.onStructuralChanged(); // 连接切换
    await vi.advanceTimersByTimeAsync(10);
    expect(saveMock).toHaveBeenCalledTimes(4);
  });

  it('RD-08 IPC 一次失败后自动重试（约 250ms）', async () => {
    let fails = 1;
    const saveMock = vi.fn((req: { snapshot: { revision: number } }) => {
      if (fails-- > 0) return Promise.reject(new Error('模拟 IPC 失败'));
      return Promise.resolve({ saved: true, acceptedRevision: req.snapshot.revision, storedRevision: req.snapshot.revision, reason: 'saved' });
    });
    const { coordinator, saveMock: _sm } = makeCoordinator({ save: saveMock as never });
    await coordinator.start();
    coordinator.resume();

    coordinator.onContentChanged();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 10);
    // 第一次失败 → 250ms 重试成功
    await vi.advanceTimersByTimeAsync(250 + 10);
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toBe('idle');
  });

  it('RD-09 连续三次失败：非阻塞告警（failed 状态）且不无限重试', async () => {
    const saveMock = vi.fn(() => Promise.reject(new Error('持续失败')));
    const { coordinator } = makeCoordinator({ save: saveMock as never });
    await coordinator.start();
    coordinator.resume();

    coordinator.onContentChanged();
    await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 10);
    // 250 + 1000 + 4000 三次退避
    await vi.advanceTimersByTimeAsync(250 + 1000 + 4000 + 300);
    expect(saveMock).toHaveBeenCalledTimes(MAX_RETRIES_TEST);
    expect(coordinator.getState()).toBe('failed');
  });

  it('RD-10 flush 成功：deadline 前完成', async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.start();
    coordinator.resume();
    coordinator.onContentChanged();

    const flushPromise = coordinator.flush(1500);
    await vi.advanceTimersByTimeAsync(100);
    const res = await flushPromise;
    expect(res.ok).toBe(true);
  });

  it('RD-11 flush 超时不永久阻塞关闭', async () => {
    const saveMock = vi.fn(() => new Promise<WorkspaceSaveResult>(() => {})); // 永不 resolve
    const { coordinator } = makeCoordinator({ save: saveMock as never });
    await coordinator.start();
    coordinator.resume();
    coordinator.onContentChanged();

    const flushPromise = coordinator.flush(50);
    await vi.advanceTimersByTimeAsync(60);
    const res = await flushPromise;
    expect(res.ok).toBe(false); // 超时返回，不卡死
  });

  it('RD-12 hydrate 期间不写错误默认快照', async () => {
    const { coordinator, saveMock } = makeCoordinator();
    // 未调用 resume()（仍在 hydrate 屏障）
    await coordinator.start();
    expect(coordinator.isHydrating()).toBe(true);

    // 屏障内的事件全部忽略
    coordinator.onContentChanged();
    coordinator.onStructuralChanged();
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('启动恢复后 revision 起点 = storedRevision + 1', async () => {
    const loadResult: WorkspaceLoadResult = {
      snapshot: {
        workspaceId: 'default',
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        revision: 42,
        activeTabId: null,
        currentConnectionId: null,
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        tabs: [],
      },
      recoveredTabCount: 0,
      quarantinedTabCount: 0,
      warnings: [],
    };
    const { coordinator, saveCalls } = makeCoordinator({
      load: vi.fn(async () => loadResult),
    });
    await coordinator.start();
    expect(coordinator.getNextRevision()).toBe(43);
    coordinator.resume();
    coordinator.onStructuralChanged();
    await vi.advanceTimersByTimeAsync(10);
    expect(saveCalls[0]!.revision).toBe(43);
  });
});

const MAX_RETRIES_TEST = 3;