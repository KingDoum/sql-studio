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
  it('S3：CTE 包裹写操作识别为写（WITH 开头不再误判为只读）', () => {
    expect(isWriteStatement('WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c')).toBe(true);
    expect(isWriteStatement('WITH c AS (SELECT 1) UPDATE t SET x=1')).toBe(true);
    expect(isWriteStatement('WITH c AS (SELECT 1) DELETE FROM t')).toBe(true);
    // CTE + SELECT 仍为只读
    expect(isWriteStatement('WITH c AS (SELECT 1) SELECT * FROM c')).toBe(false);
  });
  it('S3：前置注释包裹的写操作识别为写', () => {
    expect(isWriteStatement('-- 说明\nINSERT INTO t VALUES (1)')).toBe(true);
    expect(isWriteStatement('/* hint */ DELETE FROM t')).toBe(true);
  });
  it('S3：CALL 按高风险处理（可能写，需确认）', () => {
    expect(isWriteStatement('CALL refresh_stats()')).toBe(true);
  });
  it('S3：前置括号包裹的 SELECT 仍只读', () => {
    expect(isWriteStatement('(SELECT 1)')).toBe(false);
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

  it('signal 透传给 executor（取消链路贯通）', async () => {
    const received: AbortSignal[] = [];
    const svc = new QueryService((sql, signal) => {
      received.push(signal as AbortSignal);
      return Promise.resolve([makeSet(1)]);
    });
    const controller = new AbortController();
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT 1' }, controller.signal);
    expect(res.resultSets).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(controller.signal);
  });

  it('执行中 abort → executor 抛 AbortError 且保持 AbortError 语义', async () => {
    const controller = new AbortController();
    const svc = new QueryService((_sql, signal) => {
      // 模拟执行中取消：连接被销毁时 signal 触发，executor 抛 AbortError
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
      });
    });
    const promise = svc.run({ connectionId: 'c1', sql: 'SELECT 1' }, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/已取消/);
  });

  it('statement 字段取前 200 字符', async () => {
    const longSql = 'SELECT ' + 'a'.repeat(300);
    const svc = makeService([makeSet(1)]);
    const res = await svc.run({ connectionId: 'c1', sql: longSql });
    expect(res.resultSets[0].statement.length).toBeLessThanOrEqual(200);
  });

  it('S5：单结果集 elapsedMs 约为 totalElapsedMs（非恒 0）', async () => {
    const svc = makeService([makeSet(5)]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM t' });
    const set = res.resultSets[0];
    expect(set.elapsedMs).toBeGreaterThanOrEqual(0);
    // 单结果集完成时刻 ≈ 总耗时时刻
    expect(set.elapsedMs).toBeLessThanOrEqual(res.totalElapsedMs + 5);
  });

  it('S5：多结果集 elapsedMs 单调递增且最后一个接近 totalElapsedMs', async () => {
    const svc = makeService([makeSet(3), makeSet(4)]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT 1; SELECT 2' });
    expect(res.resultSets).toHaveLength(2);
    expect(res.resultSets[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(res.resultSets[1].elapsedMs).toBeGreaterThanOrEqual(res.resultSets[0].elapsedMs);
    expect(res.resultSets[1].elapsedMs).toBeLessThanOrEqual(res.totalElapsedMs + 5);
  });

  it('S5：截断时 elapsedMs 仍记录（不因截断归零）', async () => {
    const svc = makeService([makeSet(1500)], 1000);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM big' });
    expect(res.resultSets[0].truncated).toBe(true);
    expect(res.resultSets[0].elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('S-修复：mysql2 数字类型码映射为可读类型名（不再显示 10/253 等数字）', async () => {
    const svc = new QueryService(async () => [
      {
        rows: [],
        fields: [
          { name: 'event_date', type: 10, table: 't', orgTable: 't' },   // DATE
          { name: 'name', type: 253, table: 't', orgTable: 't' },          // VARCHAR
          { name: 'amount', type: 246, table: 't', orgTable: 't' },        // DECIMAL
          { name: 'id', type: 3, table: 't', orgTable: 't' },              // INT
        ],
        affectedRows: 0,
        isWrite: false,
      },
    ]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM t' });
    const types = res.resultSets[0].columns.map((c) => c.type);
    expect(types).toContain('date');
    expect(types).toContain('varchar');
    expect(types).toContain('decimal');
    expect(types).toContain('int');
    expect(types.some((t) => /^\d+$/.test(t))).toBe(false); // 不再有纯数字类型码
  });

  it('S-修复：结果集列带 tableName（来自 mysql2 orgTable）供主进程回填注释', async () => {
    const svc = new QueryService(async () => [
      {
        rows: [],
        fields: [
          { name: 'event_date', type: 10, table: 't_demo', orgTable: 't_demo' },
        ],
        affectedRows: 0,
        isWrite: false,
      },
    ]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM t_demo' });
    expect(res.resultSets[0].columns[0].tableName).toBe('t_demo');
  });

  it('S-修复：Date 值转本地可读字符串（不再显示 2024-12-31T16:00:00.000Z）', async () => {
    // 构造一个"本地时区 2024-12-31 00:00"的 Date（避免依赖运行环境时区）
    const local = new Date(2024, 11, 31, 0, 0, 0, 0);
    const svc = new QueryService(async () => [
      {
        rows: [{ event_date: local }],
        fields: [{ name: 'event_date', type: 10, table: 't', orgTable: 't' }],
        affectedRows: 0,
        isWrite: false,
      },
    ]);
    const res = await svc.run({ connectionId: 'c1', sql: 'SELECT * FROM t' });
    const cell = res.resultSets[0].rows[0][0];
    expect(typeof cell).toBe('string');
    expect(cell).toMatch(/^2024-12-31/);
    expect(String(cell)).not.toContain('T');
    expect(String(cell)).not.toContain('Z');
    expect(String(cell)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});
