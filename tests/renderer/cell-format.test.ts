/**
 * cell-format 纯逻辑测试（任务 10）。
 */
import { describe, it, expect } from 'vitest';
import {
  formatCell,
  compareCell,
  matchesFilter,
  isWriteStatement,
  hasWriteStatements,
} from '@renderer/lib/cell-format';

describe('formatCell', () => {
  it('NULL → NULL 字符串', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(undefined)).toBe('NULL');
  });
  it('Uint8Array → 二进制标记', () => {
    expect(formatCell(new Uint8Array([1, 2, 3]))).toBe('[二进制 3 字节]');
  });
  it('数字保留原文', () => {
    expect(formatCell(42)).toBe('42');
    expect(formatCell(3.14)).toBe('3.14');
  });
  it('字符串照原样', () => {
    expect(formatCell('hello')).toBe('hello');
  });
});

describe('compareCell', () => {
  it('NULL 恒小于非 NULL', () => {
    expect(compareCell(null, 1)).toBe(-1);
    expect(compareCell(1, null)).toBe(1);
    expect(compareCell(null, null)).toBe(0);
  });
  it('数字按数值比较', () => {
    expect(compareCell(5, 10)).toBeLessThan(0);
    expect(compareCell(10, 5)).toBeGreaterThan(0);
  });
  it('字符串 localeCompare', () => {
    expect(compareCell('a', 'b')).toBeLessThan(0);
  });
});

describe('matchesFilter', () => {
  it('空关键词通过', () => {
    expect(matchesFilter(42, '')).toBe(true);
  });
  it('模糊匹配包含', () => {
    expect(matchesFilter('hello world', 'wor')).toBe(true);
    expect(matchesFilter('hello world', 'xyz')).toBe(false);
  });
  it('NULL 匹配 null', () => {
    expect(matchesFilter(null, 'null')).toBe(true);
  });
});

describe('isWriteStatement', () => {
  it('写入类语句返回 true', () => {
    expect(isWriteStatement('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isWriteStatement('UPDATE t SET a=1')).toBe(true);
    expect(isWriteStatement('DELETE FROM t')).toBe(true);
    expect(isWriteStatement('DROP TABLE t')).toBe(true);
    expect(isWriteStatement('CREATE TABLE t (id INT)')).toBe(true);
    expect(isWriteStatement('ALTER TABLE t ADD c INT')).toBe(true);
  });
  it('只读语句返回 false', () => {
    expect(isWriteStatement('SELECT 1')).toBe(false);
    expect(isWriteStatement('SHOW TABLES')).toBe(false);
    expect(isWriteStatement('-- comment')).toBe(false);
  });
});

describe('hasWriteStatements', () => {
  it('多语句中含写操作', () => {
    expect(hasWriteStatements(['SELECT 1', 'UPDATE t SET a=1'])).toBe(true);
    expect(hasWriteStatements(['SELECT 1', 'SELECT 2'])).toBe(false);
  });
});