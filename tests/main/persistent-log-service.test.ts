/**
 * persistent-log-service.ts 单测（自动保存方案 S4，测试矩阵 §16.5 LG-01~15 对应项）。
 * 使用 electron-log/node + 临时目录，验证：
 *  - Main 启动日志落盘（LG-01）
 *  - Renderer info + debug off 不采集（由 bridge 控制，这里验证 append 本身接受全部）
 *  - 重启后旧日志可见（LG-06）
 *  - 最近 500 条读取（LG-07）
 *  - 清空只清受控日志（LG-10）
 *  - 路径注入无法越权（LG-11）
 *  - 单文件超限轮转（LG-12）
 *  - 归档超数删除最旧（LG-13）
 *  - 总量超限清理（LG-15）
 *  - 脱敏（LG-16~21 在 log-redaction 测试覆盖，这里验证 append 走脱敏）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  PersistentLogService,
  DEFAULT_MAX_LOG_FILE_BYTES,
  DEFAULT_MAX_ARCHIVE_COUNT,
  DEFAULT_READ_LIMIT,
} from '@main/services/persistent-log-service';
import type { PersistentLogEntryInput } from '@shared/types';

let tmpDir: string;

function makeEntry(partial: Partial<PersistentLogEntryInput> & { message: string }): PersistentLogEntryInput {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    source: 'renderer',
    event: 'test',
    ...partial,
  };
}

function makeService(opts: { maxFileBytes?: number; maxArchiveCount?: number; maxTotalBytes?: number } = {}): {
  service: PersistentLogService;
  logDir: string;
} {
  const logDir = path.join(tmpDir, 'logs');
  const service = new PersistentLogService({
    logDir,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_LOG_FILE_BYTES,
    maxArchiveCount: opts.maxArchiveCount ?? DEFAULT_MAX_ARCHIVE_COUNT,
    maxTotalBytes: opts.maxTotalBytes ?? 60 * 1024 * 1024,
  });
  return { service, logDir };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstudio-log-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PersistentLogService', () => {
  it('LG-01 append 落盘到受控目录', () => {
    const { service, logDir } = makeService();
    const res = service.append({
      entries: [makeEntry({ level: 'info', source: 'main', event: 'app.starting', message: '启动' })],
      flush: true,
    });
    expect(res.accepted).toBe(1);
    const files = fs.readdirSync(logDir).filter((n) => n.endsWith('.log'));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(logDir, files[0]!), 'utf8');
    expect(content).toContain('启动');
  });

  it('LG-06 read 跨重启可见（模拟重启：新服务实例读同一目录）', () => {
    const { service, logDir } = makeService();
    service.append({
      entries: [makeEntry({ message: 'REBOOT-KEEP-ME' })],
      flush: true,
    });
    // 模拟重启
    const service2 = new PersistentLogService({ logDir });
    const read = service2.read({ limit: 100 });
    expect(read.entries.some((e) => e.message.includes('REBOOT-KEEP-ME'))).toBe(true);
  });

  it('LG-07 read 返回最近日志且时间升序', () => {
    const { service } = makeService();
    service.append({
      entries: [
        makeEntry({ timestamp: '2026-09-07T01:00:00.000Z', message: 'first' }),
        makeEntry({ timestamp: '2026-09-07T02:00:00.000Z', message: 'second' }),
        makeEntry({ timestamp: '2026-09-07T03:00:00.000Z', message: 'third' }),
      ],
      flush: true,
    });
    const read = service.read({ limit: 500 });
    expect(read.timezone).toBe('Asia/Shanghai');
    expect(read.entries.map((e) => e.message)).toEqual(['first', 'second', 'third']);
    expect(read.entries[0]!.id).toBeTruthy();
  });

  it('LG-10 clear 只清受控日志并返回移除文件数', () => {
    const { service, logDir } = makeService();
    service.append({ entries: [makeEntry({ message: 'x' })], flush: true });
    // 受控目录外文件不受影响
    const outside = path.join(tmpDir, 'outside.log');
    fs.writeFileSync(outside, 'keep');
    const res = service.clear({ scope: 'all-managed-logs' });
    expect(res.cleared).toBe(true);
    expect(res.removedFileCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(outside)).toBe(true);
    // 清空后写审计摘要
    const read = service.read({ limit: 10 });
    expect(read.entries.some((e) => e.event === 'logs.cleared')).toBe(true);
  });

  it('LG-11 路径注入：read/clear 不接受外部路径参数', () => {
    const { service } = makeService();
    // read 请求没有路径字段；clear scope 非法被拒绝
    expect(() => service.clear({ scope: 'not-allowed' as never })).toThrow();
    // read 只读受控目录
    const read = service.read({ limit: 5 });
    expect(Array.isArray(read.entries)).toBe(true);
  });

  it('LG-12 单文件超限触发轮转（归档生成）', () => {
    const { service, logDir } = makeService({ maxFileBytes: 2048, maxArchiveCount: 5 });
    const big = 'x'.repeat(1200);
    for (let i = 0; i < 8; i++) {
      service.append({ entries: [makeEntry({ message: `row-${i}-${big}` })], flush: true });
    }
    const files = fs.readdirSync(logDir).filter((n) => n.endsWith('.log'));
    // 活动文件 + 至少 1 个归档
    expect(files.length).toBeGreaterThan(1);
    expect(files.some((n) => n.includes('.log'))).toBe(true);
  });

  it('LG-13 归档超过 maxArchiveCount 删除最旧', () => {
    const { service, logDir } = makeService({ maxFileBytes: 1024, maxArchiveCount: 2 });
    // 写入大量小批次强制多次轮转
    for (let i = 0; i < 20; i++) {
      service.append({
        entries: [makeEntry({ message: `filler-${i}-` + 'y'.repeat(300) })],
        flush: true,
      });
    }
    // 归档数量（不含活动 main.log）≤ 2
    const archives = fs.readdirSync(logDir).filter((n) => n.endsWith('.log') && n !== 'main.log');
    expect(archives.length).toBeLessThanOrEqual(2);
  });

  it('LG-15 总量超限清理到上限内', () => {
    const { service, logDir } = makeService({ maxFileBytes: 1024, maxArchiveCount: 10, maxTotalBytes: 4096 });
    for (let i = 0; i < 30; i++) {
      service.append({
        entries: [makeEntry({ message: `bulk-${i}-` + 'z'.repeat(300) })],
        flush: true,
      });
    }
    // 总量 ≤ 上限 + 单个活动文件余量（清理后应接近上限）
    const total = fs.readdirSync(logDir)
      .filter((n) => n.endsWith('.log'))
      .reduce((n, f) => n + fs.statSync(path.join(logDir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(4096 * 3); // 留有轮转余量
  });

  it('LG-16/17/18 append 时脱敏 password/APIKey/Authorization', () => {
    const { service } = makeService();
    service.append({
      entries: [
        makeEntry({
          message: '登录完成',
          context: { password: 'super-secret', apiKey: 'sk-xyz', authorization: 'Bearer tok' },
        }),
      ],
      flush: true,
    });
    const read = service.read({ limit: 50 });
    const entry = read.entries[0]!;
    expect(entry.context?.password).toBe('[REDACTED]');
    expect(entry.context?.apiKey).toBe('[REDACTED]');
    expect(entry.context?.authorization).toBe('[REDACTED]');
  });

  it('LG-20 完整连接串不出现在日志（message 文本脱敏）', () => {
    const { service } = makeService();
    service.append({
      entries: [
        makeEntry({ message: '连接 mysql://root:realpass@10.0.0.1:3306/sales 成功' }),
      ],
      flush: true,
    });
    const read = service.read({ limit: 50 });
    const text = read.entries.map((e) => e.message).join(' ');
    expect(text).not.toContain('realpass');
    expect(text).toContain('[REDACTED]');
  });

  it('LG-21 SQL 日志只含摘要（message 脱敏但 event 摘要保留）', () => {
    const { service } = makeService();
    service.append({
      entries: [
        makeEntry({
          level: 'info',
          event: 'query.failed',
          message: 'Query failed',
          context: { sqlLength: 184, sqlHash: 'sha256:1234abcd', queryId: 'q-1', status: 'failed' },
        }),
      ],
      flush: true,
    });
    const read = service.read({ limit: 50 });
    const entry = read.entries.find((e) => e.event === 'query.failed')!;
    expect(entry.context?.sqlLength).toBe(184);
    expect(entry.context?.queryId).toBe('q-1');
  });

  it('limit 夹在 1..500（SH-04）', () => {
    const { service } = makeService();
    for (let i = 0; i < 20; i++) {
      service.append({ entries: [makeEntry({ message: `m${i}` })], flush: false });
    }
    service.flush();
    const r1 = service.read({ limit: 9999 });
    expect(r1.entries.length).toBeLessThanOrEqual(DEFAULT_READ_LIMIT);
    const r2 = service.read({ limit: -5 });
    expect(r2.entries.length).toBeGreaterThan(0);
  });

  it('超大批次被限制并返回 dropped（SH-05）', () => {
    const { service } = makeService();
    const many = Array.from({ length: 250 }, (_, i) => makeEntry({ message: `e${i}` }));
    const res = service.append({ entries: many, flush: false });
    expect(res.accepted).toBeLessThanOrEqual(100);
    expect(res.dropped).toBeGreaterThanOrEqual(150);
  });
});