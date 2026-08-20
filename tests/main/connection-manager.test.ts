/**
 * connection-manager.ts 单测（任务 4 main-connection）。
 * mock mysql2 工厂，无需真实 MySQL。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConnectionManager,
  normalizeConnectionError,
  type Mysql2Factory,
  type PoolLike,
  type PooledConnection,
  type SingleConnectionLike,
} from '@main/services/connection-manager';
import type { ConnectionConfig, ConnectionInput } from '@shared/types';

/** 构造一个假连接（记录 execute/query/release 调用）。 */
function makeFakeConnection(): SingleConnectionLike {
  const connection = {
    query: vi.fn(async () => [[{ '1': 1 }], []]) as unknown as PooledConnection['query'],
    execute: vi.fn(async () => [[{ ok: true }], []]) as unknown as PooledConnection['execute'],
    release: vi.fn(),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  };
  return connection as unknown as SingleConnectionLike;
}

/** 构造一个假池。 */
function makeFakePool(): { pool: PoolLike; conn: SingleConnectionLike } {
  const conn = makeFakeConnection();
  const pool = {
    getConnection: vi.fn(async () => conn),
    end: vi.fn(async () => {}),
    query: vi.fn(async () => [[], []]) as unknown as PoolLike['query'],
  } as unknown as PoolLike;
  return { pool, conn };
}

/** 工厂 mock：可按用例控制 createPool / createConnection 行为。 */
class FakeFactory implements Mysql2Factory {
  poolBehavior: () => PoolLike;
  connBehavior: () => Promise<SingleConnectionLike> | SingleConnectionLike;
  createPoolCalls = 0;
  constructor(
    poolBehavior: () => PoolLike,
    connBehavior: () => Promise<SingleConnectionLike> | SingleConnectionLike,
  ) {
    this.poolBehavior = poolBehavior;
    this.connBehavior = connBehavior;
  }
  createPool(cfg: Record<string, unknown>): PoolLike {
    this.createPoolCalls += 1;
    return this.poolBehavior();
  }
  createConnection(cfg: Record<string, unknown>): Promise<SingleConnectionLike> {
    return Promise.resolve(this.connBehavior());
  }
}

function baseConfig(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'conn_1',
    name: '本地',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'secret',
    database: 'test',
    charset: 'utf8mb4',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

function baseInput(over: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: '本地',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'secret',
    database: 'test',
    charset: 'utf8mb4',
    ...over,
  };
}

describe('getPool 建池与复用', () => {
  it('首次获取创建池，再次获取复用同一池（createPool 仅调用一次）', () => {
    const { pool } = makeFakePool();
    const factory = new FakeFactory(() => pool, () => makeFakeConnection() as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory);
    const p1 = mgr.getPool(baseConfig());
    const p2 = mgr.getPool(baseConfig());
    expect(p1).toBe(p2);
    expect(factory.createPoolCalls).toBe(1);
    expect(mgr.activePoolIds()).toContain('conn_1');
  });

  it('不同 id 创建不同池', () => {
    const f1 = makeFakePool();
    const f2 = makeFakePool();
    let i = 0;
    const factory = new FakeFactory(
      () => (i++ === 0 ? f1.pool : f2.pool),
      () => makeFakeConnection() as unknown as SingleConnectionLike,
    );
    const mgr = new ConnectionManager(factory);
    mgr.getPool(baseConfig({ id: 'a' }));
    mgr.getPool(baseConfig({ id: 'b' }));
    expect(mgr.activePoolIds().sort()).toEqual(['a', 'b']);
  });
});

describe('空闲超时销毁', () => {
  it('空闲超过 idleTimeoutMs 后自动 end 并移出', async () => {
    vi.useFakeTimers();
    const { pool, conn } = makeFakePool();
    const factory = new FakeFactory(() => pool, () => conn as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory, { idleTimeoutMs: 1000 });
    mgr.getPool(baseConfig());
    expect(mgr.activePoolIds()).toContain('conn_1');
    // 推进时间触发销毁
    await vi.advanceTimersByTimeAsync(1001);
    expect(mgr.activePoolIds()).not.toContain('conn_1');
    expect(pool.end).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('再次访问会刷新计时器（不销毁）', async () => {
    vi.useFakeTimers();
    const { pool } = makeFakePool();
    const factory = new FakeFactory(() => pool, () => makeFakeConnection() as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory, { idleTimeoutMs: 1000 });
    mgr.getPool(baseConfig());
    await vi.advanceTimersByTimeAsync(500);
    mgr.getPool(baseConfig()); // 刷新
    await vi.advanceTimersByTimeAsync(600); // 距上次访问 600 < 1000
    expect(mgr.activePoolIds()).toContain('conn_1');
    vi.useRealTimers();
  });
});

describe('closePool / closeAll', () => {
  it('closePool 主动关闭并移出', async () => {
    const { pool } = makeFakePool();
    const factory = new FakeFactory(() => pool, () => makeFakeConnection() as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory);
    mgr.getPool(baseConfig());
    await mgr.closePool('conn_1');
    expect(mgr.activePoolIds()).not.toContain('conn_1');
    expect(pool.end).toHaveBeenCalled();
  });

  it('closeAll 关闭全部', async () => {
    const f1 = makeFakePool();
    const f2 = makeFakePool();
    let i = 0;
    const factory = new FakeFactory(
      () => (i++ === 0 ? f1.pool : f2.pool),
      () => makeFakeConnection() as unknown as SingleConnectionLike,
    );
    const mgr = new ConnectionManager(factory);
    mgr.getPool(baseConfig({ id: 'a' }));
    mgr.getPool(baseConfig({ id: 'b' }));
    await mgr.closeAll();
    expect(mgr.activePoolIds()).toHaveLength(0);
    expect(f1.pool.end).toHaveBeenCalled();
    expect(f2.pool.end).toHaveBeenCalled();
  });
});

describe('testConnection', () => {
  it('成功：返回 ok=true', async () => {
    const conn = makeFakeConnection();
    const factory = new FakeFactory(() => makeFakePool().pool, () => conn as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory);
    const res = await mgr.testConnection(baseInput());
    expect(res.ok).toBe(true);
    expect(res.message).toBe('连接成功');
    expect(conn.query).toHaveBeenCalledWith('SELECT 1');
    expect(conn.end).toHaveBeenCalled();
  });

  it('失败：规范化错误，ok=false', async () => {
    const conn = makeFakeConnection();
    conn.query = vi.fn(async () => {
      const e: Record<string, unknown> = { code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied' };
      throw e;
    });
    const factory = new FakeFactory(() => makeFakePool().pool, () => conn as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory);
    const res = await mgr.testConnection(baseInput());
    expect(res.ok).toBe(false);
    expect(res.message).toContain('访问被拒绝');
    expect(conn.end).toHaveBeenCalled();
  });

  it('超时分支：ETIMEDOUT 友好消息', async () => {
    const factory = new FakeFactory(() => makeFakePool().pool, () => {
      const e: Record<string, unknown> = { code: 'ETIMEDOUT', message: 'timeout' };
      return Promise.reject(e) as unknown as SingleConnectionLike;
    });
    const mgr = new ConnectionManager(factory);
    const res = await mgr.testConnection(baseInput());
    expect(res.ok).toBe(false);
    expect(res.message).toContain('超时');
  });
});

describe('execute', () => {
  it('通过池取连接执行并归还', async () => {
    const { pool, conn } = makeFakePool();
    const factory = new FakeFactory(() => pool, () => makeFakeConnection() as unknown as SingleConnectionLike);
    const mgr = new ConnectionManager(factory);
    const { rows } = await mgr.execute(baseConfig(), 'SELECT * FROM t WHERE id = ?', [1]);
    expect(conn.execute).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?', [1]);
    expect(conn.release).toHaveBeenCalled();
    expect(rows).toEqual([{ ok: true }]);
  });
});

describe('normalizeConnectionError', () => {
  const cases: [string, string][] = [
    ['ETIMEDOUT', '超时'],
    ['ECONNREFUSED', '拒绝'],
    ['ENOTFOUND', '解析'],
    ['ER_ACCESS_DENIED_ERROR', '访问被拒绝'],
    ['ER_BAD_DB_ERROR', '不存在'],
    ['PROTOCOL_CONNECTION_LOST', '断开'],
  ];
  it.each(cases)('code=%s → 含「%s」', (code, expectText) => {
    expect(normalizeConnectionError({ code })).toContain(expectText);
  });

  it('无错误对象返回未知', () => {
    expect(normalizeConnectionError(null)).toBe('未知连接错误');
  });

  it('未识别 code 回退原始 message', () => {
    expect(normalizeConnectionError({ message: '自定义错误' })).toBe('自定义错误');
  });
});
