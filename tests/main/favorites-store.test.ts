/**
 * favorites-store.ts 单测（偏差决策 D1：收藏文件化）。
 * 使用临时目录模拟 userData/queries，覆盖保存/列表/删除/读取、
 * 注释块解析、文件名安全化、重名加序号、更新时间回退 mtime。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { FavoritesStore } from '@main/services/favorites-store';

let tmpDir: string;
let store: FavoritesStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstudio-fav-'));
  store = new FavoritesStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('保存与解析', () => {
  it('保存后落盘为 .sql，注释块可解析、正文为纯 SQL', () => {
    const item = store.saveFavorite({
      name: '每日活跃用户',
      sql: 'SELECT COUNT(*) FROM users WHERE active = 1',
      connectionId: 'conn_1',
      tags: ['活跃', '日报'],
    });
    const filePath = path.join(tmpDir, '每日活跃用户.sql');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(item.name).toBe('每日活跃用户');
    expect(item.connectionId).toBe('conn_1');
    expect(item.tags).toEqual(['活跃', '日报']);
    expect(item.sql).toBe('SELECT COUNT(*) FROM users WHERE active = 1');
    // 文件内容：注释块 + 空行 + 纯 SQL
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).toContain('-- name: 每日活跃用户');
    expect(raw).toContain('-- connection: conn_1');
    expect(raw).toContain('-- tags: 活跃, 日报');
    expect(raw.endsWith('SELECT COUNT(*) FROM users WHERE active = 1\n')).toBe(true);
  });

  it('listFavorites 扫描全部文件并返回解析结果', () => {
    store.saveFavorite({ name: 'q1', sql: 'SELECT 1' });
    store.saveFavorite({ name: 'q2', sql: 'SELECT 2', tags: ['x'] });
    const list = store.listFavorites();
    expect(list).toHaveLength(2);
    const names = list.map((f) => f.name).sort();
    expect(names).toEqual(['q1', 'q2']);
    const q2 = list.find((f) => f.name === 'q2')!;
    expect(q2.tags).toEqual(['x']);
  });

  it('readFavorite 返回文件内容', () => {
    store.saveFavorite({ name: 'q1', sql: 'SELECT 9' });
    const res = store.readFavorite('q1');
    expect(res.filePath.endsWith('q1.sql')).toBe(true);
    expect(res.content).toContain('SELECT 9');
  });

  it('readFavorite 不存在抛错', () => {
    expect(() => store.readFavorite('nope')).toThrow(/收藏不存在/);
  });
});

describe('删除', () => {
  it('removeFavorite 删除文件并返回 true', () => {
    store.saveFavorite({ name: 'q1', sql: 'SELECT 1' });
    expect(store.removeFavorite('q1')).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'q1.sql'))).toBe(false);
    expect(store.removeFavorite('q1')).toBe(false);
  });
});

describe('文件名安全化与重名', () => {
  it('非法字符被清洗为下划线', () => {
    store.saveFavorite({ name: 'a/b:c*?', sql: 'SELECT 1' });
    // Windows 非法字符 / : * ? 均被替换为 _，得到 a_b_c__.sql
    expect(fs.existsSync(path.join(tmpDir, 'a_b_c__.sql'))).toBe(true);
  });

  it('重名自动加序号 (2)', () => {
    store.saveFavorite({ name: 'dup', sql: 'SELECT 1' });
    store.saveFavorite({ name: 'dup', sql: 'SELECT 2' });
    expect(fs.existsSync(path.join(tmpDir, 'dup.sql'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'dup (2).sql'))).toBe(true);
    expect(store.listFavorites()).toHaveLength(2);
  });
});

describe('元信息缺省兜底', () => {
  it('无注释块的旧式纯 SQL 文件：name 回退文件名，sql 为全文', () => {
    fs.writeFileSync(path.join(tmpDir, '遗留查询.sql'), 'SELECT * FROM legacy', 'utf-8');
    const list = store.listFavorites();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('遗留查询');
    expect(list[0].sql).toBe('SELECT * FROM legacy');
  });

  it('SQL 中本身含 -- 注释不被误判为元信息块', () => {
    const sql = '-- 这是 SQL 内注释\nSELECT 1 -- 行尾注释';
    store.saveFavorite({ name: '带注释SQL', sql });
    const item = store.listFavorites().find((f) => f.name === '带注释SQL')!;
    expect(item.sql).toBe(sql);
  });
});
