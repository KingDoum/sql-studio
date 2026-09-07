/**
 * 工作区持久化协调器（自动保存方案 §10）。
 *
 * 职责（只做调度与快照构建，不直接操作 Zustand 内部实现细节）：
 * - SQL 内容编辑 500ms trailing debounce。
 * - 结构事件（新建/关闭/切换/重排/打开文件/手动保存/连接切换）立即排队。
 * - 单消费者串行队列 + latest-wins（generation 判断）。
 * - 每次实际发送分配递增 revision；Main 侧再按 revision 防旧覆盖（§10.1/§8.5）。
 * - 自动重试最多 3 次（≈250ms / 1s / 4s + jitter，§10.4）。
 * - 启动 hydrate 屏障：恢复完成前不触发自动保存，避免写错误默认快照（§11.2/RD-12）。
 * - 退出 flush：饿汉式 drain + 截止时间，超时不永久阻塞退出（§10.5/RD-11）。
 *
 * 产物约束：
 * - 只保存恢复所需字段（§7.2 白名单）；execution/results/executing/密码/凭据绝不入快照。
 * - 自动保存绝不调用 script:save / 文件保存对话框 / 改变真实文件 mtime（§7.3）。
 */

import type {
  WorkspaceLoadResult,
  WorkspaceSaveRequest,
  WorkspaceSaveResult,
  WorkspaceSnapshot,
  WorkspaceTabSnapshot,
} from '@shared/types';
import { WORKSPACE_SCHEMA_VERSION } from '@shared/types';

export const CONTENT_DEBOUNCE_MS = 500;
export const FLUSH_DEADLINE_MS = 1500;
export const MAX_RETRIES = 3;
/** 重试退避（§10.4）：第 i 次失败后约 retryDelays[i-1] ms 重试。 */
export const RETRY_DELAYS = [250, 1000, 4000];

export type PersistState = 'idle' | 'saving' | 'failed';

export interface WorkspacePersistenceDeps {
  /** 构建当前纯数据快照（revision 由协调器统一分配）。 */
  buildSnapshot(): Omit<WorkspaceSnapshot, 'revision'>;
  /** 实际保存调用（preload）。 */
  save(req: WorkspaceSaveRequest): Promise<WorkspaceSaveResult>;
  /** 启动恢复加载。 */
  load(): Promise<WorkspaceLoadResult>;
  /** 状态回调（可选，用于 UI 非阻塞告警）。 */
  onStateChange?(state: PersistState): void;
  /** 重试延迟函数（可选，测试注入确定性延迟；默认带 jitter，§10.4）。 */
  retryDelayMs?(attempt: number): number;
}

export interface FlushResult {
  ok: boolean;
  persistedGeneration: number;
  generation: number;
}

export class WorkspacePersistenceCoordinator {
  private generation = 0;
  private persistedGeneration = 0;
  private nextRevision = 1;
  private running = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private stopped = false;
  /** 启动恢复完成前为 true：禁止触发自动保存（hydrate 屏障，§11.2）。 */
  private hydrating = true;
  private state: PersistState = 'idle';

  constructor(private readonly deps: WorkspacePersistenceDeps) {}

  // ─────────────────────────────────────────────────────────────
  // 启动恢复
  // ─────────────────────────────────────────────────────────────

  /** 应用启动时调用：load → hydrate（由调用方应用）→ 解除屏障并设置 revision 起点。 */
  async start(): Promise<WorkspaceLoadResult> {
    this.hydrating = true;
    const result = await this.deps.load();
    // revision 起点 = storedRevision + 1（§11.2）
    this.nextRevision = (result.snapshot?.revision ?? 0) + 1;
    this.persistedGeneration = 0;
    this.generation = 0;
    // 解除屏障：由调用方在 hydrate 完成后调用 resume()
    return result;
  }

  /** hydrate 完成后解除自动保存屏障。 */
  resume(): void {
    this.hydrating = false;
  }

  /** 是否仍在恢复屏障内（调用方 / 测试用）。 */
  isHydrating(): boolean {
    return this.hydrating;
  }

  // ─────────────────────────────────────────────────────────────
  // 事件入口
  // ─────────────────────────────────────────────────────────────

  /** SQL 内容编辑：500ms trailing debounce（§10.1）。 */
  onContentChanged(): void {
    if (this.hydrating || this.stopped) return;
    this.generation += 1;
    this.resetDebounce(CONTENT_DEBOUNCE_MS);
  }

  /** 结构事件：立即排队（§10.1）。 */
  onStructuralChanged(): void {
    if (this.hydrating || this.stopped) return;
    this.generation += 1;
    this.cancelDebounce();
    void this.drain();
  }

  /** 取消当前防抖（退出/结构事件时用）。 */
  cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 串行队列（latest-wins，§10.2/10.3）
  // ─────────────────────────────────────────────────────────────

  private resetDebounce(ms: number): void {
    this.cancelDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain();
    }, ms);
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.setState('saving');
    let retryExhausted = false;
    try {
      while (this.persistedGeneration < this.generation) {
        const targetGeneration = this.generation;
        const snapshot = this.buildSnapshot();

        try {
          const result = await this.deps.save({ snapshot });
          this.acceptResult(result);
          this.persistedGeneration = targetGeneration;
          this.retryAttempt = 0;
        } catch (error) {
          this.retryAttempt += 1;
          const err = error as { message?: string };
          this.setFailedOnce(err?.message);
          // 自动连续重试最多 3 次（§10.4）；达到上限后停止，等待用户后续事件重新触发
          if (this.retryAttempt >= MAX_RETRIES) {
            retryExhausted = true;
            break;
          }
          await this.waitWithBackoff(this.retryAttempt);
          // 等待期间状态又变化 → 继续循环保存最新 generation
        }
      }
    } finally {
      this.running = false;
      if (this.persistedGeneration < this.generation) this.setState('failed');
      else this.setState('idle');
      if (!this.stopped && !retryExhausted && this.persistedGeneration < this.generation) {
        this.scheduleRetry();
      }
    }
  }

  private waitWithBackoff(attempt: number): Promise<void> {
    const base = RETRY_DELAYS[attempt - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1] ?? 1000;
    const delay = this.deps.retryDelayMs
      ? this.deps.retryDelayMs(attempt)
      : base * (0.8 + Math.random() * 0.4); // 小幅 jitter（§10.4）
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private scheduleRetry(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain();
    }, 250);
  }

  private buildSnapshot(): WorkspaceSnapshot {
    const base = this.deps.buildSnapshot();
    const now = new Date().toISOString();
    const snapshot: WorkspaceSnapshot = {
      ...base,
      workspaceId: 'default',
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision: this.nextRevision++,
      updatedAt: now,
    };
    return snapshot;
  }

  private acceptResult(result: WorkspaceSaveResult): void {
    if (result.saved) {
      // 已持久化；后续 revision 继续递增
      return;
    }
    // stale-revision：Main 已存更高版本 → 以 storedRevision 为准推进
    if (result.reason === 'stale-revision' && result.storedRevision >= result.acceptedRevision) {
      this.nextRevision = result.storedRevision + 1;
    }
  }

  private setFailedOnce(message?: string): void {
    // 记录一次失败摘要（不记录 SQL 正文，§10.4）
    if (this.state !== 'failed') {
      this.setState('failed');
      this.onFailure?.(message);
    }
  }

  private onFailure: ((message?: string) => void) | undefined;

  set onFailureCallback(fn: ((message?: string) => void) | undefined) {
    this.onFailure = fn;
  }

  private setState(s: PersistState): void {
    this.state = s;
    this.deps.onStateChange?.(s);
  }

  getState(): PersistState {
    return this.state;
  }

  // ─────────────────────────────────────────────────────────────
  // 退出 flush（§10.5）
  // ─────────────────────────────────────────────────────────────

  /** flush：取消防抖并尽量在截止时间内持久化最新状态。 */
  async flush(deadlineMs: number = FLUSH_DEADLINE_MS): Promise<FlushResult> {
    this.cancelDebounce();
    if (this.hydrating || this.stopped) {
      return { ok: true, persistedGeneration: this.persistedGeneration, generation: this.generation };
    }
    if (this.persistedGeneration < this.generation) {
      const drainPromise = this.drain();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, deadlineMs));
      await Promise.race([drainPromise, timeout]);
    }
    return {
      ok: this.persistedGeneration >= this.generation,
      persistedGeneration: this.persistedGeneration,
      generation: this.generation,
    };
  }

  /** 完全停止（退出后调用，防止尾部重试）。 */
  stop(): void {
    this.stopped = true;
    this.cancelDebounce();
  }

  // 测试辅助
  getNextRevision(): number {
    return this.nextRevision;
  }

  getPersistedGeneration(): number {
    return this.persistedGeneration;
  }
}

// ─────────────────────────────────────────────────────────────
// 纯快照构建辅助（store 无关：调用方传入 tabs 等纯数据）
// ─────────────────────────────────────────────────────────────

export interface SnapshotSource {
  activeTabId: string | null;
  currentConnectionId: string | null;
  tabs: Array<{
    id: string;
    title: string;
    filePath?: string;
    sql: string;
    isDirty: boolean;
    connectionId?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

/**
 * 把 store 纯状态转成工作区快照（不含 revision，由协调器分配）。
 * 只挑选恢复所需字段；不保存 execution / results / executing / 凭据（§7.2）。
 */
export function buildSnapshotFromSource(src: SnapshotSource, now = new Date().toISOString()): Omit<WorkspaceSnapshot, 'revision'> {
  const tabs: WorkspaceTabSnapshot[] = src.tabs.map((t, index) => ({
    id: t.id,
    tabOrder: index,
    title: t.title,
    filePath: t.filePath ?? null,
    sqlContent: t.sql,
    isDirty: t.isDirty,
    connectionId: t.connectionId ?? null,
    createdAt: t.createdAt ?? now,
    updatedAt: t.updatedAt ?? now,
  }));
  return {
    workspaceId: 'default',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeTabId: src.activeTabId,
    currentConnectionId: src.currentConnectionId,
    createdAt: now,
    updatedAt: now,
    tabs,
  };
}

/**
 * 分类 store 状态变化：内容事件（SQL 编辑 → 500ms 防抖）vs 结构事件（立即保存）。
 * 规则（方案 §7.6）：
 * - activeTabId / currentConnectionId / 标签增删重排 / title / filePath / connectionId 变化 → structural
 * - 仅某标签 sql 变化（updateSql 同时改 isDirty）→ content
 * - 仅 isDirty 变化（markSaved 清脏）→ structural（立即保存非脏快照）
 */
export type WorkspaceChangeKind = 'content' | 'structural' | 'none';

interface ChangeProbe {
  tabs: Array<{
    id: string;
    title: string;
    filePath?: string;
    sql: string;
    isDirty: boolean;
    connectionId?: string;
  }>;
  activeTabId: string | null;
  currentConnectionId: string | null;
}

export function classifyWorkspaceChange(prev: ChangeProbe, next: ChangeProbe): WorkspaceChangeKind {
  if (prev.activeTabId !== next.activeTabId || prev.currentConnectionId !== next.currentConnectionId) {
    return 'structural';
  }
  if (prev.tabs.length !== next.tabs.length) {
    return 'structural';
  }
  let content = false;
  for (let i = 0; i < next.tabs.length; i++) {
    const a = prev.tabs[i];
    const b = next.tabs[i];
    if (!a || !b) return 'structural';
    if (a.id !== b.id || a.title !== b.title || a.filePath !== b.filePath || a.connectionId !== b.connectionId) {
      return 'structural';
    }
    if (a.sql !== b.sql) {
      content = true;
      continue;
    }
    if (a.isDirty !== b.isDirty) {
      // sql 未变但脏状态变（如 markSaved 清脏）→ 结构事件立即保存
      return 'structural';
    }
  }
  return content ? 'content' : 'none';
}