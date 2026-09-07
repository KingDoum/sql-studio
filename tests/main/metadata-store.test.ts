/**
 * metadata-store.ts 单测（任务 3）。
 * 使用临时 sqlite 文件 + 注入 Security（mock 加密器），覆盖 CRUD、密文落库、
 * 迁移、边界（空/超长）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
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
  it('初次创建后 schema_version = 2（自动保存方案 v2 迁移）', () => {
    expect(store.getVersion()).toBe(2);
  });

  it('v1 旧库打开后升级到 v2：新增工作区表、旧数据不变、迁移幂等（MS-01）', () => {
    // 手工构造 v1 库（仅 v1 表 + schema_version=1 + 一条连接）
    const dbPath = path.join(tmpDir, 'v1-lib.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE connections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
        user TEXT NOT NULL, password TEXT NOT NULL, database TEXT,
        charset TEXT NOT NULL DEFAULT 'utf8mb4', max_connections INTEGER,
        idle_timeout_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- v1 时代密码即 b64: 前缀降级密文（与 Security 兼容）
      INSERT INTO connections (id, name, host, port, user, password, database, charset, created_at, updated_at)
      VALUES ('v1conn', '旧连接', '127.0.0.1', 3306, 'root', 'b64:' || '${Buffer.from('pw').toString('base64')}', 'db1', 'utf8mb4', 1, 1);
      CREATE TABLE history (id TEXT PRIMARY KEY, connection_id TEXT, connection_name TEXT, sql TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1, row_count INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0, executed_at INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    raw.close();

    // 用 MetadataStore 打开：应执行 v1 → v2 迁移
    const upgraded = new MetadataStore({ dbPath, security: mockSecurity });
    expect(upgraded.getVersion()).toBe(2);
    // 旧连接仍在（b64: 降级密文可被 Security 解密取回）
    expect(upgraded.listConnections()).toHaveLength(1);
    expect(upgraded.getConnectionConfig('v1conn')?.password).toBe('pw');
    // 工作区表已建
    const tables = upgraded.getSharedDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_snapshots','workspace_tabs')")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['workspace_snapshots', 'workspace_tabs']);
    upgraded.close();

    // 再次打开：迁移幂等，不重复破坏
    const reopened = new MetadataStore({ dbPath, security: mockSecurity });
    expect(reopened.getVersion()).toBe(2);
    expect(reopened.listConnections()).toHaveLength(1);
    reopened.close();
  });

  it('settings 读写（V2 预留）', () => {
    store.setSetting('ai.enabled', 'false');
    expect(store.getSetting('ai.enabled')).toBe('false');
    expect(store.getSetting('missing')).toBeNull();
  });
});

describe('AiConfig 与 AiPublicConfig（阶段 3：API Key 不泄露给 Renderer）', () => {
  const cfg = {
    enabled: true,
    baseUrl: 'https://api.deepseek.com/beta',
    model: 'deepseek-v4-pro',
    apiKey: 'sk-secret-123',
    protocol: 'deepseek-fim' as const,
  };

  it('保存后 getAiConfig（内部）能解密取回 Key', () => {
    store.setAiConfig(cfg);
    const internal = store.getAiConfig();
    expect(internal?.apiKey).toBe('sk-secret-123');
    expect(internal?.protocol).toBe('deepseek-fim');
  });

  it('getAiPublicConfig 不含 apiKey，仅 apiKeyConfigured=true', () => {
    store.setAiConfig(cfg);
    const pub = store.getAiPublicConfig();
    expect(pub).not.toBeNull();
    expect((pub as any).apiKey).toBeUndefined();
    expect(pub?.apiKeyConfigured).toBe(true);
    expect(pub?.baseUrl).toBe('https://api.deepseek.com/beta');
    expect(pub?.enabled).toBe(true);
  });

  it('未配置 Key 时 getAiPublicConfig.apiKeyConfigured=false', () => {
    store.setAiConfig({ ...cfg, apiKey: '' });
    const pub = store.getAiPublicConfig();
    expect(pub?.apiKeyConfigured).toBe(false);
  });

  it('空 Key 保存时保留旧 Key（不意外清空）', () => {
    store.setAiConfig(cfg);
    // 用空 apiKey 保存 → 旧 Key 保留
    store.setAiConfig({ ...cfg, apiKey: '' });
    expect(store.getAiConfig()?.apiKey).toBe('sk-secret-123');
    expect(store.getAiPublicConfig()?.apiKeyConfigured).toBe(true);
  });

  it('新 Key 保存后替换旧 Key', () => {
    store.setAiConfig(cfg);
    store.setAiConfig({ ...cfg, apiKey: 'sk-new-key' });
    expect(store.getAiConfig()?.apiKey).toBe('sk-new-key');
  });

  it('getAiPublicConfig 在无配置时返回 null', () => {
    expect(store.getAiPublicConfig()).toBeNull();
  });
});

describe('AiConfig 请求策略 rateLimit（阶段 A：外观与 AI 限流）', () => {
  const baseCfg = {
    enabled: true,
    baseUrl: 'https://api.deepseek.com/beta',
    model: 'deepseek-v4-pro',
    apiKey: 'sk-secret-123',
    protocol: 'deepseek-fim' as const,
  };

  /** 直接向 settings 表写入一段「旧版 JSON」（无 rateLimit 字段），模拟历史配置。 */
  const writeRawAiConfig = (raw: string) => {
    (store as any).setSetting('ai_config', raw);
  };

  it('旧配置无 rateLimit 时 getAiPublicConfig 补四个默认值', () => {
    writeRawAiConfig(JSON.stringify({ ...baseCfg }));
    const pub = store.getAiPublicConfig();
    expect(pub?.rateLimit).toEqual({
      debounceMs: 400,
      minRequestIntervalMs: 2500,
      rateLimitCooldownMs: 15_000,
      requestTimeoutMs: 12_000,
    });
  });

  it('getAiConfig（Main 内部）旧配置同样补默认 rateLimit', () => {
    writeRawAiConfig(JSON.stringify({ ...baseCfg }));
    const internal = store.getAiConfig();
    expect(internal?.rateLimit).toEqual({
      debounceMs: 400,
      minRequestIntervalMs: 2500,
      rateLimitCooldownMs: 15_000,
      requestTimeoutMs: 12_000,
    });
    expect(internal?.apiKey).toBe('sk-secret-123'); // Key 解密不受影响
  });

  it('保存时越界值被归一化（低于最小值 / 高于最大值）', () => {
    store.setAiConfig({
      ...baseCfg,
      rateLimit: {
        debounceMs: 1,
        minRequestIntervalMs: 999_999,
        rateLimitCooldownMs: 10,
        requestTimeoutMs: 1,
      } as never,
    });
    const internal = store.getAiConfig();
    expect(internal?.rateLimit).toEqual({
      debounceMs: 150,
      minRequestIntervalMs: 30_000,
      rateLimitCooldownMs: 1000,
      requestTimeoutMs: 3000,
    });
  });

  it('保存时小数 / NaN / 字符串污染不会进入运行时配置', () => {
    store.setAiConfig({
      ...baseCfg,
      rateLimit: {
        debounceMs: Number.NaN,
        minRequestIntervalMs: '2500' as unknown as number,
        rateLimitCooldownMs: 5000.6,
        requestTimeoutMs: 12_000,
      } as never,
    });
    const internal = store.getAiConfig();
    expect(internal?.rateLimit?.debounceMs).toBe(400);
    expect(internal?.rateLimit?.minRequestIntervalMs).toBe(2500);
    expect(internal?.rateLimit?.rateLimitCooldownMs).toBe(5001);
    expect(internal?.rateLimit?.requestTimeoutMs).toBe(12_000);
  });

  it('getAiPublicConfig 返回 rateLimit 但不返回 apiKey', () => {
    store.setAiConfig({ ...baseCfg, rateLimit: { debounceMs: 200, minRequestIntervalMs: 1000, rateLimitCooldownMs: 5000, requestTimeoutMs: 8000 } });
    const pub = store.getAiPublicConfig();
    expect(pub?.rateLimit?.debounceMs).toBe(200);
    expect((pub as unknown as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('空 API Key 保存（含 rateLimit）仍然保留旧密文', () => {
    store.setAiConfig({ ...baseCfg });
    store.setAiConfig({ ...baseCfg, apiKey: '', rateLimit: { debounceMs: 300, minRequestIntervalMs: 1500, rateLimitCooldownMs: 8000, requestTimeoutMs: 9000 } });
    expect(store.getAiConfig()?.apiKey).toBe('sk-secret-123');
    expect(store.getAiConfig()?.rateLimit?.debounceMs).toBe(300);
    expect(store.getAiPublicConfig()?.apiKeyConfigured).toBe(true);
  });
});
