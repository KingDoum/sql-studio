/**
 * query-service.ts 单测（任务 5）。
 * mock executor，覆盖上限截断、多语句拆分、错误分支、耗时、写类、取消。
 */
import { describe, it, expect, vi } from 'vitest';
import { QueryService, splitStatements, isWriteStatement, type RawResultSet } from '@main/services/query-service';
import type { QueryRequest } from '@shared/types';

/** 构造一个返回 N 行、字段为 [c1] 的结果集。 */
function makeSet(rowCount: number, hasFields = true, affectedRows = 0): RawResultSet {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ c1: i }));
  return {
    rows,
    fields: hasFields ? [{ name: 'c1', type: 'int' }] : [],
    affectedRows,
    isWrite: !hasFields,
  };
}

function makeService(sets: RawResultSet[], maxRows = 1000): QueryService {
  const executor = vi.fn(async () => sets);
  return new QueryService(executor, { maxRows });
}

describe('splitStatements', () => {
  it('按顶层分号拆分', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('忽略引号内分号', () => {
    expect(splitStatements("SELECT ';'; SELECT 2")).toEqual(["SELECT ';'", 'SELECT 2']);
  });
  it('忽略行内注释分号', () => {
    expect(splitStatements('SELECT 1 -- a; b\n; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('忽略块注释分号', () => {
    expect(splitStatements('SELECT 1 /* ; */; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('末尾无分号也收集', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });
});

describe('isWriteStatement', () => {
  it('SELECT/SHOW 非写', () => {
    expect(isWriteStatement('SELECT * FROM t')).toBe(false);
    expect(isWriteStatement('show tables')).toBe(false);
  });
  it('INSERT/UPDATE/DELETE 为写', () => {
    expect(isWriteStatement('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isWriteStatement('update t set x=1')).toBe(true);
    expect(isWriteStatement('DELETE FROM t')).toBe(true);
  });
});

describe('QueryService.run', () => {
  it('单语句返回 1 个结果集', async () => {
    const svc = makeService([makeSet(3)]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM t' });
    expect(res.resultSets).toHaveLength(1);
    expect(res.resultSets[0].rows).toHaveLength(3);
    expect(res.totalElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('多语句返回多个结果集', async () => {
    const svc = makeService([makeSet(2), makeSet(1)]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT 1; SELECT 2' });
    expect(res.resultSets).toHaveLength(2);
    expect(res.resultSets[0].rows).toHaveLength(2);
    expect(res.resultSets[1].rows).toHaveLength(1);
  });

  it('超限截断并标记 truncated', async () => {
    const svc = makeService([makeSet(1500)], 1000);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM big' });
    expect(res.resultSets[0].rows).toHaveLength(1000);
    expect(res.resultSets[0].truncated).toBe(true);
    expect(res.truncated).toBe(true);
  });

  it('未超限不截断', async () => {
    const svc = makeService([makeSet(500)], 1000);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM t' });
    expect(res.resultSets[0].truncated).toBe(false);
  });

  it('写类语句标记 hasWrite + affectedRows', async () => {
    const svc = makeService([makeSet(0, false, 5)], 1000);
    const res = await svc.run({ connectionId: 'c1', sql: 'INSERT INTO t VALUES (1)' });
    expect(res.hasWrite).toBe(true);
    expect(res.resultSets[0].affectedRows).toBe(5);
  });

  it('错误透传', async () => {
    const svc = new QueryService(async () => {
      throw new Error('语法错误 near SELECT');
    });
    await expect(svc.run({ connectionId: 'c1', sql: 'BAD SQL' })).rejects.toThrow(/语法错误/);
  });

  it('取消信号（AbortError）透传', async () => {
    const svc = makeService([makeSet(1)]);
    const controller = new AbortController();
    controller.abort();
    await expect(svc.run({ connectionId: 'c1', sql: 'SELECT 1' }, controller.signal)).rejects.toThrow(/已取消/);
  });

  it('statement 字段取前 200 字符', async () => {
    const longSql = 'SELECT ' + 'a'.repeat(300);
    const svc = makeService([makeSet(1)]);
    const res = await svc.run({ connectionId: 'c1', sql: longSql });
    expect(res.resultSets[0].statement.length).toBeLessThanOrEqual(200);
  });
});
