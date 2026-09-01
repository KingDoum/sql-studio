// @vitest-environment jsdom
/**
 * debug-log.ts 单测（阶段 4：调试日志显示北京时间 UTC+8）。
 * 覆盖：
 *  - 内部 DebugLogEntry.time 继续保存 ISO UTC（用于排序/机器处理）；
 *  - formatBeijingTime 把 ISO UTC 转为北京时间（含毫秒）；
 *  - 固定时间：2026-09-01T03:51:13.784Z → 2026-09-01 11:51:13.784；
 *  - formatLogEntryLine / formatDebugLogText 的展示均为北京时间；
 *  - 标题使用北京时间。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  enableDebugLogging,
  clearDebugLogs,
  getDebugLogEntries,
  formatBeijingTime,
  formatLogEntryLine,
  formatDebugLogText,
} from '@renderer/lib/debug-log';

const FIXED_ISO = '2026-09-01T03:51:13.784Z';
const EXPECTED_BEIJING = '2026-09-01 11:51:13.784';

describe('formatBeijingTime（UTC+8）', () => {
  it('固定时间 2026-09-01T03:51:13.784Z → 2026-09-01 11:51:13.784', () => {
    expect(formatBeijingTime(FIXED_ISO)).toBe(EXPECTED_BEIJING);
  });

  it('毫秒保留（3 位）', () => {
    expect(formatBeijingTime('2026-09-01T03:51:13.007Z')).toBe('2026-09-01 11:51:13.007');
  });

  it('跨日正确进位（UTC 深夜 → 北京时间次日）', () => {
    expect(formatBeijingTime('2026-08-31T17:00:00.000Z')).toBe('2026-09-01 01:00:00.000');
  });

  it('非法时间原样返回', () => {
    expect(formatBeijingTime('not-a-date')).toBe('not-a-date');
  });
});

describe('debug 日志展示为北京时间', () => {
  beforeEach(() => {
    clearDebugLogs();
    enableDebugLogging();
    // 用固定时间戳写入一条日志（直接构造 entries 不经过 console，保证确定性）
    const entries = getDebugLogEntries() as unknown as Array<{ time: string; level: string; message: string; detail?: string }>;
    // push 通过内部模块数组不可直接注入，改用 console 拦截 + 手动改写 time
    // 这里直接调用 formatLogEntryLine 测试展示层，不依赖时间写入
  });
  afterEach(() => {
    clearDebugLogs();
  });

  it('formatLogEntryLine 使用北京时间，不再直接显示 UTC', () => {
    const line = formatLogEntryLine({
      time: FIXED_ISO,
      level: 'info',
      message: '行内补全触发',
      detail: 'prefixLen=12',
    });
    expect(line).toContain(`[${EXPECTED_BEIJING}]`);
    expect(line).toContain('[INFO]');
    expect(line).toContain('prefixLen=12');
  });

  it('formatLogEntryLine 不包含 UTC 原样的 HH:mm:ss 片段（避免回归 e.time.slice(11,19)）', () => {
    const line = formatLogEntryLine({
      time: FIXED_ISO,
      level: 'warn',
      message: 'warn msg',
    });
    // 03:51:13 是 UTC 片段，不应出现在北京时间行内
    expect(line).not.toContain('03:51:13');
    expect(line).toContain('11:51:13');
  });

  it('formatDebugLogText 标题使用北京时间', () => {
    const text = formatDebugLogText(10);
    expect(text).toMatch(/北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  it('内部 DebugLogEntry.time 仍为 ISO UTC（可排序/机器处理）', () => {
    // 写入一条真实日志，校验 entries 内 time 仍是 ISO（Z 结尾）
    console.info('北京时间日志测试');
    const entries = getDebugLogEntries();
    const hit = entries.find((e) => e.message.includes('北京时间日志测试'));
    expect(hit).toBeDefined();
    // ISO UTC 形如 2026-09-01T03:51:13.784Z（末尾 Z 表示 UTC）
    expect(hit!.time.endsWith('Z')).toBe(true);
    // 排序稳定性：时间戳字符串可直接比较
    expect(hit!.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});