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

describe('重命名', () => {
  it('renameFavorite 改文件名 + 注释块 name，保留 SQL', () => {
    store.saveFavorite({ name: '旧名', sql: 'SELECT 1', connectionId: 'c1', tags: ['a'] });
    const renamed = store.renameFavorite('旧名', '新名');
    expect(renamed.name).toBe('新名');
    expect(renamed.connectionId).toBe('c1');
    expect(renamed.tags).toEqual(['a']);
    expect(renamed.sql).toBe('SELECT 1');
    // 旧文件删除、新文件存在
    const list = store.listFavorites();
    expect(list.some((f) => f.name === '新名')).toBe(true);
    expect(list.some((f) => f.name === '旧名')).toBe(false);
  });

  it('renameFavorite 目标重名抛错且不破坏源文件', () => {
    store.saveFavorite({ name: '甲', sql: 'SELECT 1' });
    store.saveFavorite({ name: '乙', sql: 'SELECT 2' });
    expect(() => store.renameFavorite('甲', '乙')).toThrow('已存在');
    // 源文件仍在
    expect(store.listFavorites().some((f) => f.name === '甲')).toBe(true);
  });

  it('renameFavorite 不存在抛错', () => {
    expect(() => store.renameFavorite('不存在', '新名')).toThrow('不存在');
  });
});

describe('定位规则统一（S1）', () => {
  it('readFavorite 支持 meta.name 回扫（旧格式文件头与文件名不一致）', () => {
    fs.writeFileSync(path.join(tmpDir, 'history.sql'), '-- name: 历史查询\n\nSELECT 1', 'utf-8');
    const res = store.readFavorite('历史查询');
    expect(res.filePath).toBe(path.join(tmpDir, 'history.sql'));
  });

  it('readFavorite 精确文件名优先于 meta.name 回扫', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.sql'), '-- name: b\n\nSELECT 1', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'b.sql'), '-- name: x\n\nSELECT 2', 'utf-8');
    const res = store.readFavorite('b');
    expect(res.filePath).toBe(path.join(tmpDir, 'b.sql'));
  });

  it('removeFavorite 通过 meta.name 回扫删除旧格式', () => {
    fs.writeFileSync(path.join(tmpDir, 'legacy.sql'), '-- name: 旧收藏\n\nSELECT 1', 'utf-8');
    expect(store.removeFavorite('旧收藏')).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'legacy.sql'))).toBe(false);
  });

  it('renameFavorite 目标与已有收藏逻辑重名（meta.name）时报错且不破坏源', () => {
    store.saveFavorite({ name: '甲', sql: 'SELECT 1' });
    fs.writeFileSync(path.join(tmpDir, 'other.sql'), '-- name: 乙\n\nSELECT 2', 'utf-8');
    expect(() => store.renameFavorite('甲', '乙')).toThrow('已存在');
    expect(fs.existsSync(path.join(tmpDir, '甲.sql'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'other.sql'))).toBe(true);
    expect(store.listFavorites().some((f) => f.name === '甲')).toBe(true);
  });
});

describe('名称边界安全（S1）', () => {
  it('保存路径分隔符/绝对路径不会越出收藏目录', () => {
    const item = store.saveFavorite({ name: '../../../etc/passwd', sql: 'SELECT 1' });
    expect(path.dirname(item.filePath)).toBe(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.._.._.._etc_passwd.sql'))).toBe(true);
  });

  it('Windows 盘符路径被安全化且不越出目录', () => {
    const item = store.saveFavorite({ name: 'C:\\Users\\admin\\evil', sql: 'SELECT 1' });
    expect(path.dirname(item.filePath)).toBe(tmpDir);
  });

  it('Windows 保留设备名被安全化', () => {
    for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con']) {
      const item = store.saveFavorite({ name: reserved, sql: 'SELECT 1' });
      expect(path.basename(item.filePath)).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)/i);
      expect(path.dirname(item.filePath)).toBe(tmpDir);
      store.removeFavorite(reserved);
    }
  });

  it('超长名称被截断到安全长度', () => {
    const item = store.saveFavorite({ name: 'x'.repeat(300), sql: 'SELECT 1' });
    expect(path.basename(item.filePath).length).toBeLessThanOrEqual(130);
  });

  it('空名称保存为兜底名称', () => {
    const item = store.saveFavorite({ name: '', sql: 'SELECT 1' });
    expect(item.name).toBe('未命名收藏');
  });

  it('纯点名称不会生成非法文件', () => {
    const item = store.saveFavorite({ name: '.', sql: 'SELECT 1' });
    expect(path.basename(item.filePath)).not.toBe('.sql');
    expect(item.name).toBeTruthy();
    expect(path.dirname(item.filePath)).toBe(tmpDir);
  });

  it('相似名称不会误匹配删除（q1 不影响 q1 (2)）', () => {
    store.saveFavorite({ name: 'q1', sql: 'SELECT 1' });
    store.saveFavorite({ name: 'q1', sql: 'SELECT 2' }); // 产生 q1.sql 与 q1 (2).sql
    expect(store.removeFavorite('q1')).toBe(true);
    expect(store.listFavorites().some((f) => f.name === 'q1 (2)')).toBe(true);
  });

  it('重命名失败时源文件不被破坏', () => {
    store.saveFavorite({ name: '甲', sql: 'SELECT 1' });
    store.saveFavorite({ name: '乙', sql: 'SELECT 2' });
    expect(() => store.renameFavorite('甲', '乙')).toThrow();
    expect(fs.existsSync(path.join(tmpDir, '甲.sql'))).toBe(true);
    expect(store.readFavorite('甲').content).toContain('SELECT 1');
  });

  it('大小写相近名称按精确文件匹配，不误删（Linux 大小写敏感）', () => {
    store.saveFavorite({ name: 'Report', sql: 'SELECT 1' });
    expect(store.removeFavorite('report')).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'Report.sql'))).toBe(true);
  });
});
