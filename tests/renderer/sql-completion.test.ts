/**
 * SchemaCompletionProvider 纯逻辑测试（任务 9）。
 */
import { describe, it, expect } from 'vitest';
import {
  SchemaCompletionProvider,
  getKeywordCompletionItems,
  endWithQualifiedDot,
  isTableContext,
  isDotEnding,
  extractTableAliases,
  type SchemaSnapshot,
} from '@renderer/lib/sql-completion';

function makeSnapshot(partial: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    connectionId: 'c1',
    database: 'app',
    databases: ['app', 'shop'],
    tables: [
      { name: 'users', type: 'table', isView: false, comment: '用户表' },
      { name: 'orders', type: 'table', isView: false },
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
  it('无快照时仅返回关键字', () => {
    const p = new SchemaCompletionProvider(null);
    const items = p.provideCompletions({ prefix: '', word: '' });
    expect(items.every((i) => i.category === 'keyword')).toBe(true);
  });

  it('默认上下文返回 关键字+表+库，按 score 排序（表>库>关键字）', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT * FROM ', word: '' });
    expect(items.some((i) => i.label === 'users' && i.category === 'table')).toBe(true);
    expect(items.some((i) => i.label === 'app' && i.category === 'database')).toBe(true);
    expect(items.some((i) => i.label === 'SELECT' && i.category === 'keyword')).toBe(true);
    // 排序：score 降序
    const scores = items.map((i) => i.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('表上下文（FROM 后）把表排在前面', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT * FROM ', word: '' });
    expect(items[0].category).toBe('table');
  });

  it('`表名.` 上下文返回该表字段', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT users.', word: '' });
    expect(items.some((i) => i.label === 'id' && i.category === 'column')).toBe(true);
    expect(items.some((i) => i.label === 'email' && i.category === 'column')).toBe(true);
    expect(items.some((i) => i.category === 'table')).toBe(false); // 无表项
  });

  it('`库名.` 上下文返回库分类候选', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT app.', word: '' });
    expect(items.some((i) => i.label === 'app' && i.category === 'database')).toBe(true);
  });

  it('按 word 前缀过滤', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT * FROM ', word: 'us' });
    expect(items.some((i) => i.label === 'users')).toBe(true);
    expect(items.some((i) => i.label === 'orders')).toBe(false);
  });

  it('视图也在表候选内', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT * FROM ', word: 'v' });
    expect(items.some((i) => i.label === 'v_active' && i.category === 'table')).toBe(true);
  });

  it('update() 重建后按新快照补全', () => {
    const p = new SchemaCompletionProvider(null);
    expect(p.provideCompletions({ prefix: '', word: '' }).every((i) => i.category === 'keyword')).toBe(true);
    p.update(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT * FROM ', word: '' });
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
  it('空前缀返回空', () => {
    expect(extractTableAliases('')).toEqual({});
  });
});

describe('别名补全（体验优化）', () => {
  it('`别名.` 返回对应表的字段', () => {
    const p = new SchemaCompletionProvider(makeSnapshot());
    const items = p.provideCompletions({ prefix: 'SELECT * FROM users u WHERE u.', word: '' });
    expect(items.some((i) => i.label === 'id' && i.category === 'column')).toBe(true);
    expect(items.some((i) => i.label === 'email' && i.category === 'column')).toBe(true);
  });
});