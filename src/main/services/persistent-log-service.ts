/**
 * 持久日志服务（自动保存方案 §12）。
 *
 * 基于 electron-log v5.4.4 已核实 API（S0 核实门）：
 * - `import log from 'electron-log/main'`（Main）或 `electron-log/node`（测试/Node）。
 * - file transport：`fileName` / `format`（函数可输出 JSON 行）/ `level` / `maxSize`
 *   / `resolvePathFn` / `archiveLogFn`（自定义轮转归档）/ `getFile()` / `readAllLogs()`。
 * - `LogFile.clear()` 清空当前文件；`sync:true` 同步写即时落盘。
 *
 * 职责：
 * - 日志写在 `userData/logs/` 下受控目录（resolvePathFn 显式固定，不接受外部路径）。
 * - 单文件上限（默认 10 MiB）触发自定义 archiveLogFn：归档为 `main.<ts>.log`，
 *   保留最多 5 个归档 / 14 天 / 目录总量 60 MiB（§12.8）。
 * - append 时执行 Main 侧第二层脱敏（§12.11）；Renderer 发送前已做第一层。
 * - read 返回最近 500 条（含归档，按时间升序），解析失败行计数不失败。
 * - clear 只操作受控目录内文件，清空后写审计摘要。
 *
 * 日志不进入 SQLite（§1.2）。Main 直接调用本服务，Renderer 经 `logs:*` IPC。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  LogsAppendRequest,
  LogsAppendResult,
  LogsReadRequest,
  LogsReadResult,
  LogsClearRequest,
  LogsClearResult,
  PersistentLogEntry,
  PersistentLogEntryInput,
  PersistentLogLevel,
} from '@shared/types';
import { redactObject, redactText } from './log-redaction';

/** 活动日志文件上限（§12.8）。 */
export const DEFAULT_MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
/** 最多保留归档数（§12.8）。 */
export const DEFAULT_MAX_ARCHIVE_COUNT = 5;
/** 保留期限（天）（§12.8）。 */
export const DEFAULT_MAX_AGE_DAYS = 14;
/** 日志目录总量硬上限（§12.8）。 */
export const DEFAULT_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
/** logs:read 默认与最大条数（§12.9）。 */
export const DEFAULT_READ_LIMIT = 500;
/** 单批最大条数（§12.6）。 */
export const APPEND_BATCH_LIMIT = 100;
/** 单条序列化后上限（§12.6）。 */
export const APPEND_ENTRY_BYTES_LIMIT = 32 * 1024;
/** 单批序列化上限（§12.6）。 */
export const APPEND_BATCH_BYTES_LIMIT = 256 * 1024;

export interface PersistentLogServiceDeps {
  /** 受控日志目录（生产为 `userData/logs`，测试注入临时目录）。 */
  logDir: string;
  fileName?: string;
  maxFileBytes?: number;
  maxArchiveCount?: number;
  maxAgeDays?: number;
  maxTotalBytes?: number;
  /** electron-log 实例（默认动态 require；测试注入 electron-log/node）。 */
  logger?: ElectronLoggerLike;
}

/** 最小化的 electron-log 接口（实现依赖 v5.4.4 已核实 API）。 */
export interface ElectronLoggerLike {
  transports: {
    file: {
      fileName: string;
      format: string | ((params: { data: unknown[] }) => unknown[]);
      level: string | false;
      maxSize: number;
      resolvePathFn: (vars: Record<string, unknown>, message?: unknown) => string;
      archiveLogFn: (oldLogFile: { toString(): string }) => void;
      getFile(): { path: string; clear(): boolean; size: number };
      readAllLogs(options?: { fileFilter?: (p: string) => boolean }): Array<{ path: string; lines: string[] }>;
    };
    console?: { level: string | false };
    [key: string]: unknown;
  };
  error(...params: unknown[]): void;
  warn(...params: unknown[]): void;
  info(...params: unknown[]): void;
  debug(...params: unknown[]): void;
  log(...params: unknown[]): void;
  initialize?(options?: unknown): void;
}

function loadElectronLog(): ElectronLoggerLike {
  // 生产（Electron Main）用 electron-log/main；测试环境 require('electron') 不可用时降级 node 入口。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron-log/main') as ElectronLoggerLike;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron-log/node') as ElectronLoggerLike;
  }
}

export class PersistentLogService {
  private readonly logDir: string;
  private readonly fileName: string;
  private readonly maxFileBytes: number;
  private readonly maxArchiveCount: number;
  private readonly maxAgeDays: number;
  private readonly maxTotalBytes: number;
  private readonly logger: ElectronLoggerLike;
  private initialized = false;

  constructor(deps: PersistentLogServiceDeps) {
    this.logDir = deps.logDir;
    this.fileName = deps.fileName ?? 'main.log';
    this.maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_LOG_FILE_BYTES;
    this.maxArchiveCount = deps.maxArchiveCount ?? DEFAULT_MAX_ARCHIVE_COUNT;
    this.maxAgeDays = deps.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.maxTotalBytes = deps.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.logger = deps.logger ?? loadElectronLog();
    this.init();
  }

  /** 解析后的活动日志文件路径（受控目录内）。 */
  getLogFilePath(): string {
    return path.join(this.logDir, this.fileName);
  }

  private init(): void {
    fs.mkdirSync(this.logDir, { recursive: true });
    const file = this.logger.transports.file;
    // 路径固定为受控目录（不接受外部路径，§12.7）
    file.resolvePathFn = () => this.getLogFilePath();
    file.fileName = this.fileName;
    file.level = 'silly'; // Main 自启动起始终采集（§12.5）
    file.maxSize = this.maxFileBytes;
    // 输出为单行 JSON（供 read 结构化解析）
    file.format = ({ data }) => data;
    // 自定义轮转归档：main.log → main.<ts>.log，并执行清理策略（§12.8）
    file.archiveLogFn = (oldLogFile) => {
      try {
        const oldPath = oldLogFile.toString();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archived = path.join(this.logDir, `${this.fileName.replace(/\.log$/, '')}.${stamp}.log`);
        fs.renameSync(oldPath, archived);
      } catch {
        // 归档失败不阻断写入（下次自然重来）
      }
      this.cleanup();
    };
    // 启动轻量清理（§12.8）
    this.cleanup();
    this.initialized = true;
  }

  // ─────────────────────────────────────────────────────────────
  // append（Renderer 批量 + Main 直接调用共用）
  // ─────────────────────────────────────────────────────────────

  append(req: LogsAppendRequest): LogsAppendResult {
    const entries = Array.isArray(req?.entries) ? req.entries : [];
    const flush = !!req?.flush;

    // 批量限制（§12.6）
    const acceptedInputs = entries.slice(0, APPEND_BATCH_LIMIT);
    let dropped = entries.length - acceptedInputs.length;

    let batchBytes = 0;
    const toWrite: PersistentLogEntryInput[] = [];
    for (const e of acceptedInputs) {
      const sanitized = this.sanitizeEntry(e);
      const lineBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
      if (lineBytes > APPEND_ENTRY_BYTES_LIMIT) {
        // 单条超限：截断 context 保留摘要（§10.6）
        const trimmed = { ...sanitized, context: { dropped: 'entry-too-large', bytes: lineBytes } };
        if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= APPEND_BATCH_BYTES_LIMIT) {
          toWrite.push(trimmed);
        } else {
          dropped += 1;
        }
        continue;
      }
      if (batchBytes + lineBytes > APPEND_BATCH_BYTES_LIMIT) {
        dropped += entries.length - toWrite.length - dropped > 0 ? 1 : 0;
        break;
      }
      batchBytes += lineBytes;
      toWrite.push(sanitized);
    }

    for (const e of toWrite) {
      this.writeEntry(e);
    }
    if (flush) this.flush();

    return { accepted: toWrite.length, dropped };
  }

  private sanitizeEntry(e: PersistentLogEntryInput): PersistentLogEntryInput {
    return {
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString(),
      level: this.normalizeLevel(e.level),
      source: e.source === 'main' ? 'main' : 'renderer',
      event: redactText(typeof e.event === 'string' ? e.event : String(e.event ?? '')),
      message: redactText(typeof e.message === 'string' ? e.message : String(e.message ?? '')),
      context: e.context ? (redactObject(e.context) as Record<string, unknown>) : undefined,
    };
  }

  private normalizeLevel(l: unknown): PersistentLogLevel {
    if (l === 'debug' || l === 'info' || l === 'warn' || l === 'error') return l;
    return 'info';
  }

  private writeEntry(e: PersistentLogEntryInput): void {
    const line = JSON.stringify(e);
    // 已脱敏；ws 写文件时再走一遍 text 级脱敏兜底（§12.11 第三层）
    const finalLine = redactText(line);
    switch (e.level) {
      case 'error':
        this.logger.error(finalLine);
        break;
      case 'warn':
        this.logger.warn(finalLine);
        break;
      case 'debug':
        this.logger.debug(finalLine);
        break;
      default:
        this.logger.info(finalLine);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // read（§12.9：最近 500 条，按时间升序，坏行计数）
  // ─────────────────────────────────────────────────────────────

  read(req: LogsReadRequest = {}): LogsReadResult {
    const limit = this.clampLimit(req?.limit);
    const files = this.listLogFiles(); // 受控目录内全部 .log（活动 + 归档）
    const entries: Array<{ timestamp: number; entry: PersistentLogEntry }> = [];
    let badLines = 0;

    for (const filePath of files) {
      if (entries.length >= limit) break;
      let text = '';
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue; // 读失败跳过该文件，不使整个请求失败
      }
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Partial<PersistentLogEntry> & { timestamp?: string };
          if (!parsed || typeof parsed.timestamp !== 'string') {
            badLines += 1;
            continue;
          }
          const ts = Date.parse(parsed.timestamp);
          if (Number.isNaN(ts)) {
            badLines += 1;
            continue;
          }
          entries.push({
            timestamp: ts,
            entry: {
              id: this.entryId(parsed),
              timestamp: parsed.timestamp,
              level: this.normalizeLevel(parsed.level),
              source: parsed.source === 'main' ? 'main' : 'renderer',
              event: typeof parsed.event === 'string' ? parsed.event : '',
              message: typeof parsed.message === 'string' ? parsed.message : '',
              context: parsed.context && typeof parsed.context === 'object' ? parsed.context as Record<string, unknown> : undefined,
            },
          });
        } catch {
          badLines += 1; // 解析失败行计数，不让请求失败（§19.5/§12.9）
        }
      }
    }

    // 按时间升序返回（最新在尾部；超出 limit 时保留最新 limit 条）
    entries.sort((a, b) => a.timestamp - b.timestamp);
    const tail = entries.slice(-limit).map((x) => x.entry);
    return {
      entries: tail,
      timezone: 'Asia/Shanghai',
      truncated: entries.length > limit || badLines > 0,
    };
  }

  private clampLimit(limit: number | undefined): number {
    if (limit === undefined || limit === null) return DEFAULT_READ_LIMIT;
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_READ_LIMIT;
    return Math.min(Math.floor(n), DEFAULT_READ_LIMIT);
  }

  private entryId(parsed: { timestamp?: string; level?: unknown; source?: unknown; event?: unknown }): string {
    // 稳定的摘要 id（不暴露完整内容）
    const s = `${parsed.timestamp ?? ''}|${String(parsed.level ?? '')}|${String(parsed.source ?? '')}|${String(parsed.event ?? '')}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return `log-${h.toString(16).padStart(8, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────
  // clear（§12.10：只清受控日志）
  // ─────────────────────────────────────────────────────────────

  clear(req: LogsClearRequest): LogsClearResult {
    if (!req || req.scope !== 'all-managed-logs') {
      throw new Error('非法 logs:clear scope');
    }
    const managed = this.listLogFiles();
    let removedFileCount = 0;
    for (const filePath of managed) {
      // 路径安全：只操作受控目录内文件（§12.7/§13.3）
      if (!this.isControlledPath(filePath)) continue;
      try {
        fs.rmSync(filePath, { force: true });
        removedFileCount += 1;
      } catch {
        // 单个文件删除失败继续
      }
    }
    // 清空动作本身写审计摘要（§12.10）
    this.writeEntry({
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'main',
      event: 'logs.cleared',
      message: `日志已清空（${removedFileCount} 个文件）`,
    });
    return { cleared: true, removedFileCount };
  }

  // ─────────────────────────────────────────────────────────────
  // flush / 清理
  // ─────────────────────────────────────────────────────────────

  /** 退出前 flush；electron-log sync:true 已即时落盘，此处兜底刷新当前文件句柄。 */
  flush(): void {
    try {
      this.logger.transports.file.getFile().clear?.length; // touch（无副作用）
    } catch {
      // 忽略
    }
  }

  /**
   * 轻量清理（§12.8）：
   * - 归档数量 > maxArchiveCount → 删除最旧。
   * - 归档超过 maxAgeDays → 删除。
   * - 目录总量 > maxTotalBytes → 删除最旧归档直到低于上限。
   * 当前活动文件最后保留，只在官方机制允许时处理（此处永不清活动文件）。
   */
  private cleanup(): void {
    let arch = this.listArchives();
    arch.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs); // 旧 → 新

    // 1) 数量上限
    while (arch.length > this.maxArchiveCount) {
      const oldest = arch.shift();
      if (!oldest) break;
      this.tryRemove(oldest);
    }
    // 2) 期限
    const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of [...arch]) {
      try {
        if (fs.statSync(f).mtimeMs < cutoff) {
          this.tryRemove(f);
          arch = arch.filter((x) => x !== f);
        }
      } catch {
        // 忽略
      }
    }
    // 3) 总量硬上限
    let total = this.totalBytes();
    for (const f of arch) {
      if (total <= this.maxTotalBytes) break;
      const size = this.fileSize(f);
      if (this.tryRemove(f)) total -= size;
    }
  }

  private listLogFiles(): string[] {
    if (!fs.existsSync(this.logDir)) return [];
    return fs
      .readdirSync(this.logDir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => path.join(this.logDir, n))
      .filter((p) => this.isControlledPath(p));
  }

  private listArchives(): string[] {
    return this.listLogFiles().filter((p) => path.basename(p) !== this.fileName);
  }

  private isControlledPath(p: string): boolean {
    const dir = path.resolve(this.logDir);
    const resolved = path.resolve(p);
    return resolved === dir || resolved.startsWith(dir + path.sep);
  }

  private fileSize(p: string): number {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  }

  private totalBytes(): number {
    return this.listLogFiles().reduce((n, f) => n + this.fileSize(f), 0);
  }

  private tryRemove(p: string): boolean {
    try {
      fs.rmSync(p, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}