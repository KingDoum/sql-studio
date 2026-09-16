/**
 * file-name.ts 单测：导出 / 另存为默认文件名的「日期_时间」后缀。
 * 该后缀让用户不想起名时可直接回车保存（见 ExportMenu / App 另存为）。
 */
import { describe, it, expect } from 'vitest';
import { timestampSuffix, withTimestamp } from '@renderer/lib/file-name';

describe('timestampSuffix', () => {
  it('本地时间格式化为 YYYYMMDD_HHmmss（各段补零）', () => {
    expect(timestampSuffix(new Date(2026, 8, 16, 9, 5, 3))).toBe('20260916_090503');
  });

  it('不含 Windows 文件名非法字符 `:`', () => {
    const s = timestampSuffix(new Date(2026, 11, 31, 23, 59, 59));
    expect(s).not.toContain(':');
    expect(s).toBe('20261231_235959');
  });

  it('年初 / 午夜边界正确', () => {
    expect(timestampSuffix(new Date(2026, 0, 1, 0, 0, 0))).toBe('20260101_000000');
  });
});

describe('withTimestamp', () => {
  const d = new Date(2026, 8, 16, 17, 30, 45);

  it('拼接为 base_时间戳.ext（导出场景）', () => {
    expect(withTimestamp('导出结果', 'xlsx', d)).toBe('导出结果_20260916_173045.xlsx');
  });

  it('ext 允许带前导点（另存为场景）', () => {
    expect(withTimestamp('未命名', '.sql', d)).toBe('未命名_20260916_173045.sql');
  });

  it('不传日期时使用当前时间（结果仍符合后缀格式）', () => {
    expect(withTimestamp('t', 'csv')).toMatch(/^t_\d{8}_\d{6}\.csv$/);
  });
});
