/**
 * schema-cache.ts 单测（任务 5）。
 * mock executor，覆盖缓存命中、强制刷新、库/表/字段/DDL 解析。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchemaCache, type SchemaExecutor } from '@main/services/schema-cache';

describe('SchemaCache', () => {
  let executor: SchemaExecutor;
  let calls: string[];
  let store: SchemaCache;

  beforeEach(() => {
    calls = [];
    executor = vi.fn(async (sql: string): Promise<Record<string, unknown>[]> => {
      calls.push(sql);
      if (sql === 'SHOW DATABASES') return [{ 'Database': 'db1' }, { 'Database': 'db2' }];
      if (sql.startsWith('SHOW FULL TABLES FROM')) {
        return [
          { 'Tables_in_db1': 'users', 'Table_type': 'BASE TABLE' },
          { 'Tables_in_db1': 'v_active', 'Table_type': 'VIEW' },
        ];
      }
      if (sql.startsWith('SHOW FULL COLUMNS FROM')) {
        return [
          { Field: 'id', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: null, Comment: '主键' },
          { Field: 'name', Type: 'varchar(64)', Null: 'YES', Key: '', Default: null, Comment: '' },
        ];
      }
      if (sql.startsWith('SHOW CREATE TABLE')) {
        return [{ 'Create Table': 'CREATE TABLE users (id int)' }];
      }
      return [];
    }) as unknown as SchemaExecutor;
    store = new SchemaCache(executor);
  });

  it('listDatabases 拉取并缓存命中（第二次不调 executor）', async () => {
    const d1 = await store.listDatabases();
    expect(d1).toEqual(['db1', 'db2']);
    const before = calls.length;
    const d2 = await store.listDatabases();
    expect(d2).toEqual(['db1', 'db2']);
    expect(calls.length).toBe(before); // 命中缓存
  });

  it('listDatabases(force=true) 重新拉取', async () => {
    await store.listDatabases();
    const before = calls.length;
    await store.listDatabases(true);
    expect(calls.length).toBe(before + 1);
  });

  it('listTables 区分表与视图', async () => {
    const tables = await store.listTables('db1');
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ name: 'users', type: 'table', isView: false });
    expect(tables[1]).toMatchObject({ name: 'v_active', type: 'view', isView: true });
  });

  it('getColumns 解析字段元信息', async () => {
    const cols = await store.getColumns('db1', 'users');
    expect(cols[0]).toMatchObject({ name: 'id', type: 'int', nullable: false, isPrimary: true });
    expect(cols[1].nullable).toBe(true);
  });

  it('getDdl 返回建表语句', async () => {
    const ddl = await store.getDdl('db1', 'users');
    expect(ddl).toBe('CREATE TABLE users (id int)');
  });

  it('clearAll 后再次拉取触发新查询', async () => {
    await store.listDatabases();
    store.clearAll();
    const before = calls.length;
    await store.listDatabases();
    expect(calls.length).toBe(before + 1);
  });

  it('refreshTables 让表缓存失效', async () => {
    await store.listTables('db1');
    const before = calls.length;
    store.refreshTables('db1');
    await store.listTables('db1');
    expect(calls.length).toBe(before + 1);
  });
});
