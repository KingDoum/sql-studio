/**
 * metadata-store.ts 单测（任务 3）。
 * 使用临时 sqlite 文件 + 注入 Security（mock 加密器），覆盖 CRUD、密文落库、
 * 迁移、边界（空/超长）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MetadataStore } from '@main/services/metadata-store';
import { Security } from '@main/services/security';
import type { ConnectionInput } from '@shared/types';

// mock 加密器：简单 base64，便于断言密文与明文不同
const mockSecurity = new Security();

let tmpDir: string;
let store: MetadataStore;

const sampleConn: ConnectionInput = {
  name: '本地库',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 's3cret!@#',
  database: 'ads_yewu',
  charset: 'utf8mb4',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstudio-'));
  const dbPath = path.join(tmpDir, 'meta.test.db');
  store = new MetadataStore({ dbPath, security: mockSecurity });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('连接 CRUD', () => {
  it('保存并返回不含密码的摘要', () => {
    const saved = store.saveConnection(sampleConn);
    expect(saved.id).toBeTruthy();
    expect(saved.name).toBe('本地库');
    expect((saved as any).password).toBeUndefined();
  });

  it('密码以密文落库（不等于明文）', () => {
    const saved = store.saveConnection(sampleConn);
    // 通过主进程内部配置读回解密，验证密文 ≠ 明文
    const cfg = store.getConnectionConfig(saved.id)!;
    expect(cfg.password).toBe('s3cret!@#');
    // 直接查库确认存的是密文
    const db = (store as any).db;
    const row = db.prepare('SELECT password FROM connections WHERE id = ?').get(saved.id) as any;
    expect(row.password).not.toBe('s3cret!@#');
    expect(row.password.startsWith('b64:')).toBe(true);
  });

  it('list / get 不含密码', () => {
    const saved = store.saveConnection(sampleConn);
    const list = store.listConnections();
    expect(list).toHaveLength(1);
    expect((list[0] as any).password).toBeUndefined();
    const got = store.getConnection(saved.id);
    expect(got?.name).toBe('本地库');
    // 内部 config 仍含明文（仅主进程）
    expect(store.getConnectionConfig(saved.id)?.password).toBe('s3cret!@#');
  });

  it('更新连接（同 id）保留 createdAt', () => {
    const saved = store.saveConnection(sampleConn);
    const firstCreated = store.getConnectionConfig(saved.id)!.createdAt;
    const updated = store.saveConnection({ ...sampleConn, id: saved.id, name: '改名库' });
    expect(updated.name).toBe('改名库');
    expect(store.getConnectionConfig(saved.id)!.createdAt).toBe(firstCreated);
    expect(store.listConnections()).toHaveLength(1);
  });

  it('删除连接', () => {
    const saved = store.saveConnection(sampleConn);
    expect(store.removeConnection(saved.id)).toBe(true);
    expect(store.listConnections()).toHaveLength(0);
    expect(store.removeConnection(saved.id)).toBe(false);
  });

  it('边界：超长 name 与空 database 可保存', () => {
    const longName = 'x'.repeat(500);
    const saved = store.saveConnection({ ...sampleConn, name: longName, database: '' });
    expect(store.getConnection(saved.id)?.name).toBe(longName);
  });
});

describe('历史', () => {
  it('add → list 往返', () => {
    store.addHistory({
      connectionId: 'c1',
      connectionName: '本地库',
      sql: 'SELECT 1',
      success: true,
      rowCount: 10,
      elapsedMs: 25,
    });
    const list = store.listHistory();
    expect(list).toHaveLength(1);
    expect(list[0].sql).toBe('SELECT 1');
    expect(list[0].success).toBe(true);
    expect(list[0].executedAt).toBeGreaterThan(0);
  });

  it('按 connectionId 过滤', () => {
    store.addHistory({ connectionId: 'c1', sql: 'SELECT 1', success: true, rowCount: 1, elapsedMs: 1 });
    store.addHistory({ connectionId: 'c2', sql: 'SELECT 2', success: true, rowCount: 2, elapsedMs: 2 });
    expect(store.listHistory({ connectionId: 'c1' })).toHaveLength(1);
  });

  it('remove history', () => {
    const h = store.addHistory({ connectionId: 'c1', sql: 'SELECT 1', success: true, rowCount: 1, elapsedMs: 1 });
    expect(store.removeHistory(h.id)).toBe(true);
    expect(store.listHistory()).toHaveLength(0);
  });
});

describe('收藏（D1：已迁移至 favorites-store 文件库，此处仅断言 metadata-store 不再管 favorites）', () => {
  it('metadata-store 不再提供 favorites 表相关方法', () => {
    expect((store as any).saveFavorite).toBeUndefined();
    expect((store as any).listFavorites).toBeUndefined();
    expect((store as any).removeFavorite).toBeUndefined();
  });
});

describe('迁移与 settings', () => {
  it('初次创建后 schema_version = 1', () => {
    expect(store.getVersion()).toBe(1);
  });

  it('settings 读写（V2 预留）', () => {
    store.setSetting('ai.enabled', 'false');
    expect(store.getSetting('ai.enabled')).toBe('false');
    expect(store.getSetting('missing')).toBeNull();
  });
});
