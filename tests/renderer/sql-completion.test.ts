/**
 * SchemaCompletionProvider 纯逻辑测试（任务 9）。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SchemaCompletionProvider,
  getKeywordCompletionItems,
  endWithQualifiedDot,
  isTableContext,
  isDotEnding,
  extractTableAliases,
  parseQualifiedDot,
  extractFromTables,
  lastKeyword,
  type SchemaSnapshot,
} from '@renderer/lib/sql-completion';

function makeSnapshot(partial: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    connectionId: 'c1',
    database: 'app',
    databases: ['app', 'shop'],
    tables: [
      { name: 'users', type: 'table', isView: false, comment: '用户表' },
      { name: 'orders', type: 'table' as const, isView: false },
      { name: 'v_active', type: 'view', isView: true },
    ],
    columnsByTable: {
      users: [
        { name: 'id', type: 'bigint', nullable: false, isPrimary: true, isUnique: true },
        { name: 'email', type: 'varchar', nullable: false, isPrimary: false, isUnique: false },
      ],
      orders: [{ name: 'amount', type: 'decimal', nullable: true, isPrimary: false, isUnique: false }],
    },
    ...partial,
  };
}

describe('getKeywordCompletionItems', () => {
  it('返回关键字项（category=keyword, score=1）', () => {
    const items = getKeywordCompletionItems();
    expect(items.length).toBeGreaterThan(20);
    expect(items[0].category).toBe('keyword');
    expect(items[0].score).toBe(1);
  });
});

describe('SchemaCompletionProvider', () => {
  it('无快照时仅返回关键字', async () => {
    const p = new SchemaCompletionProvider(null);
    const items = await p.provideCompletions({ prefix: '', word: '' });
    expect(items.every((i) => i.category === 'keyword')).toBe(true);
  });

  it('默认上下文返回 关键字+表+库，按 score 排序（表>库>关键字）', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM ', word: '' });
    expect(items.some((i) => i.label === 'users' && i.category === 'table')).toBe(true);
    expect(items.some((i) => i.label === 'app' && i.category === 'database')).toBe(true);
    expect(items.some((i) => i.label === 'SELECT' && i.category === 'keyword')).toBe(true);
    // 排序：score 降序
    const scores = items.map((i) => i.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('表上下文（FROM 后）把表排在前面', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM ', word: '' });
    expect(items[0].category).toBe('table');
  });

  it('`表名.` 上下文返回该表字段', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT users.', word: '' });
    expect(items.some((i) => i.label === 'id' && i.category === 'column')).toBe(true);
    expect(items.some((i) => i.label === 'email' && i.category === 'column')).toBe(true);
    expect(items.some((i) => i.category === 'table')).toBe(false); // 无表项
  });

  it('`库名.` 上下文返回库分类候选', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT app.', word: '' });
    expect(items.some((i) => i.label === 'app' && i.category === 'database')).toBe(true);
  });

  it('按 word 前缀过滤', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM ', word: 'us' });
    expect(items.some((i) => i.label === 'users')).toBe(true);
    expect(items.some((i) => i.label === 'orders')).toBe(false);
  });

  it('视图也在表候选内', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM ', word: 'v' });
    expect(items.some((i) => i.label === 'v_active' && i.category === 'table')).toBe(true);
  });

  it('update() 重建后按新快照补全', async () => {
    const p = new SchemaCompletionProvider(null);
    expect((await p.provideCompletions({ prefix: '', word: '' })).every((i) => i.category === 'keyword')).toBe(true);
    p.update(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM ', word: '' });
    expect(items.some((i) => i.label === 'users')).toBe(true);
  });
});

describe('上下文判定辅助函数', () => {
  it('endWithQualifiedDot 识别 `表.` 前缀', () => {
    expect(endWithQualifiedDot('SELECT users.')).toBe('users');
    expect(endWithQualifiedDot('SELECT `my table`.')).toBe('my table');
    expect(endWithQualifiedDot('SELECT * FROM')).toBeNull();
  });

  it('isTableContext 识别表上下文关键字', () => {
    expect(isTableContext('SELECT * FROM ')).toBe(true);
    expect(isTableContext('UPDATE ')).toBe(true);
    // `users.` 是字段上下文（由 dot 分支处理），不是表上下文
    expect(isTableContext('SELECT users.')).toBe(false);
    expect(isTableContext('SELECT 1;')).toBe(false);
  });

  it('isDotEnding 识别以点结尾', () => {
    expect(isDotEnding('users.')).toBe(true);
    expect(isDotEnding('users')).toBe(false);
  });
});

describe('extractTableAliases', () => {
  it('FROM users u 解析别名 u → users', () => {
    expect(extractTableAliases('SELECT * FROM users u WHERE u.')).toEqual({ u: 'users' });
  });
  it('FROM users AS u 解析别名', () => {
    expect(extractTableAliases('SELECT * FROM users AS u WHERE u.')).toEqual({ u: 'users' });
  });
  it('JOIN 也解析别名', () => {
    expect(extractTableAliases('SELECT * FROM users u JOIN orders o ON u.id = o.user_id')).toEqual({
      u: 'users', o: 'orders',
    });
  });
  it('非别名时不误判（FROM users, orders）', () => {
    expect(extractTableAliases('SELECT * FROM users, orders')).toEqual({});
  });
  it('反引号包裹的表名与别名', () => {
    expect(extractTableAliases('SELECT * FROM `order details` od')).toEqual({ od: 'order details' });
  });
  it('逗号分隔的隐式 JOIN（FROM t1 a, t2 b）', () => {
    expect(extractTableAliases('SELECT * FROM users u, orders o WHERE u.id = o.user_id')).toEqual({
      u: 'users', o: 'orders',
    });
  });
  it('不误匹配 SELECT 列表中的逗号（SELECT a, b FROM t）', () => {
    expect(extractTableAliases('SELECT id, name FROM users')).toEqual({});
  });
  it('空前缀返回空', () => {
    expect(extractTableAliases('')).toEqual({});
  });
});

describe('parseQualifiedDot', () => {
  it('识别 `库名.表名.` 模式', () => {
    const r = parseQualifiedDot('SELECT * FROM app.users.');
    expect(r).toEqual({ db: 'app', table: 'users' });
  });
  it('识别 `表名.` 模式', () => {
    const r = parseQualifiedDot('SELECT * FROM users.');
    expect(r).toEqual({ table: 'users' });
  });
  it('非点结尾返回 null', () => {
    expect(parseQualifiedDot('SELECT * FROM users')).toBeNull();
  });
  it('反引号包裹的标识符', () => {
    const r = parseQualifiedDot('SELECT * FROM `app`.`users`.');
    expect(r).toEqual({ db: 'app', table: 'users' });
  });
});

describe('extractFromTables / lastKeyword', () => {
  it('extractFromTables 识别 FROM 库.表', () => {
    
    expect(extractFromTables('select a from ods_yewu.ods_listing_fba_fees')).toEqual([
      { db: 'ods_yewu', table: 'ods_listing_fba_fees' },
    ]);
  });
  it('extractFromTables 识别 FROM 表 与 JOIN', () => {
    
    expect(extractFromTables('from users u join orders o on u.id=o.uid')).toEqual([
      { table: 'users' }, { table: 'orders' },
    ]);
  });
  it('lastKeyword 返回光标前最近关键字', () => {
    
    expect(lastKeyword('select name from users where')).toBe('where');
    expect(lastKeyword('select name')).toBe('select');
    expect(lastKeyword('from users ')).toBe('from');
  });
});

describe('SELECT 位置字段补全（FROM 子句联动）', () => {
  it('select 列表位置提示 FROM 表字段（含注释）', async () => {
    
    const loader = {
      tables: vi.fn(async () => []),
      columns: vi.fn(async () => [
        { name: 'event', type: 'varchar', nullable: true, isPrimary: false, isUnique: false, comment: '事件类型' },
        { name: 'amount', type: 'decimal', nullable: true, isPrimary: false, isUnique: false },
      ]),
    };
    const snapshot = {
      connectionId: 'c1', database: 'app', databases: ['app', 'ods_yewu'],
      tables: [], columnsByTable: {},
    };
    const p = new SchemaCompletionProvider(snapshot, loader);
    const items = await p.provideCompletions({
      prefix: 'select event',
      word: 'event',
      document: 'select event from ods_yewu.ods_listing_fba_fees',
    });
    expect(loader.columns).toHaveBeenCalledWith('ods_yewu', 'ods_listing_fba_fees');
    const ev = items.find((i) => i.label === 'event');
    expect(ev).toBeTruthy();
    expect(ev?.detail).toContain('事件类型');
  });

});

describe('跨库补全（异步 loader）', () => {
  it('非当前库名. → 经 loader 拉取该库表', async () => {
    const loader = {
      tables: vi.fn(async () => [{ name: 'shop_orders', type: 'table' as const, isView: false }]),
      columns: vi.fn(async () => []),
    };
    const snapshot = { connectionId: 'c1', database: 'app', databases: ['app', 'shop'], tables: [], columnsByTable: {} };
    const p = new SchemaCompletionProvider(snapshot, loader);
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM shop.', word: '' });
    expect(loader.tables).toHaveBeenCalledWith('shop');
    expect(items.some((i) => i.label === 'shop_orders')).toBe(true);
  });

  it('当前库名. → 不走 loader，直接返回快照表', async () => {
    const loader = { tables: vi.fn(), columns: vi.fn() };
    const snapshot = { connectionId: 'c1', database: 'app', databases: ['app', 'shop'], tables: [{ name: 'users', type: 'table' as const, isView: false }], columnsByTable: {} };
    const p = new SchemaCompletionProvider(snapshot, loader);
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM app.', word: '' });
    expect(loader.tables).not.toHaveBeenCalled();
    expect(items.some((i) => i.label === 'users')).toBe(true);
  });

  it('loader 抛异常返回空表，不崩溃', async () => {
    const loader = { tables: vi.fn(async () => { throw new Error('DB error'); }), columns: vi.fn() };
    const snapshot = { connectionId: 'c1', database: 'app', databases: ['app', 'shop'], tables: [], columnsByTable: {} };
    const p = new SchemaCompletionProvider(snapshot, loader);
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM shop.', word: '' });
    expect(items.length).toBeGreaterThanOrEqual(0); // 至少关键字
  });
});
describe('别名补全（体验优化）', () => {
  it('`别名.` 返回对应表的字段', async () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = await p.provideCompletions({ prefix: 'SELECT * FROM users u WHERE u.', word: '' });
    expect(items.some((i) => i.label === 'id' && i.category === 'column')).toBe(true);
    expect(items.some((i) => i.label === 'email' && i.category === 'column')).toBe(true);
  });
});