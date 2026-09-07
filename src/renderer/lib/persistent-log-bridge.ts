/**
 * Renderer 持久日志桥（自动保存方案 §12.6/§14.2）。
 *
 * 职责：
 * - debugMode 开启时，把普通 log/info 批量缓冲（20 条或 250ms，先到者触发）。
 * - warn/error 即时发送（可把缓冲中的 debug/info 一起带上）。
 * - 单批最多 100 条；单批序列化 ≤256 KiB（§12.6 背压）。
 * - IPC 失败不递归调用日志入口（§12.12 重入防护）。
 * - 页面隐藏/刷新/关闭前尝试 flush。
 *
 * 与 debug-log 的衔接：App 启动时注册本桥为 debug-log 的 logSink，
 * debug-log 的每次 push 会进入本桥；本桥按级别决定批量或即时。
 */

import { toPersistentEntry } from '@renderer/lib/debug-log';
import type { PersistentLogEntryInput, LogsAppendResult } from '@shared/types';

export const BATCH_THRESHOLD = 20;
export const BATCH_DELAY_MS = 250;
export const MAX_BATCH = 100;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_SINGLE_BYTES = 32 * 1024;

interface BridgeOptions {
  /** 批量发送延迟（测试可注入）。 */
  batchDelayMs?: number;
}

export class PersistentLogBridge {
  private buffer: PersistentLogEntryInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debugMode = false;
  private stopped = false;
  private sending = false;
  private readonly batchDelayMs: number;
  private dropped = 0;

  constructor(opts: BridgeOptions = {}) {
    this.batchDelayMs = opts.batchDelayMs ?? BATCH_DELAY_MS;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  isDebugMode(): boolean {
    return this.debugMode;
  }

  getDroppedCount(): number {
    return this.dropped;
  }

  /**
   * debug-log sink 入口：接收内存日志条目并持久化转发。
   * 级别规则（§12.5/§12.6）：
   * - warn/error：立即发送（可带缓冲 debug/info）。
   * - log/info：仅 debugMode 开启时批量缓冲。
   */
  push(entry: Parameters<typeof toPersistentEntry>[0]): void {
    if (this.stopped) return;
    const level = entry.level === 'log' ? 'info' : entry.level;
    const persistent = toPersistentEntry({ ...entry, level });

    if (level === 'warn' || level === 'error') {
      this.buffer.push(persistent);
      this.cancelTimer();
      void this.sendBatch(true);
      return;
    }
    // log/info：仅 debugMode 开启时采集（§12.5/§12.6）
    if (!this.debugMode) return;
    this.buffer.push(persistent);
    if (this.buffer.length >= BATCH_THRESHOLD) {
      this.cancelTimer();
      void this.sendBatch(false);
    } else {
      this.schedule();
    }
  }

  /** 页面隐藏/刷新/关闭前 flush（§12.6）。 */
  flush(): void {
    this.cancelTimer();
    if (this.buffer.length > 0) void this.sendBatch(true);
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  // ─────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sendBatch(false);
    }, this.batchDelayMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async sendBatch(flush: boolean): Promise<void> {
    if (this.sending || this.buffer.length === 0 || this.stopped) return;
    this.sending = true;
    const batch = this.buffer.splice(0, MAX_BATCH);
    try {
      await window.sqlStudio['logs:append']({ entries: batch, flush });
    } catch {
      // IPC 失败：丢弃本批并计数（不递归调用日志入口，§12.12）
      this.dropped += batch.length;
    } finally {
      this.sending = false;
      // 批量发送后若仍有积压且 debugMode 开，继续排程
      if (!this.stopped && this.buffer.length > 0 && this.timer === null) {
        this.schedule();
      }
    }
  }
}

/** 全局单例桥（App 初始化时注册为 debug-log sink）。 */
export const persistentLogBridge = new PersistentLogBridge();

/** 供测试断言序列化大小用。 */
export function estimateBatchBytes(entries: PersistentLogEntryInput[]): number {
  return entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0);
}

export type { LogsAppendResult };
