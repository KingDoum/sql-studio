/**
 * ipc.ts 集成测试（任务 7）。
 * mock ipcMain.handle 收集 handler；直接调用 handler 注入 mock deps，覆盖成功/失败与历史自动记录。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { registerIpc, type IpcDeps } from '@main/ipc';
import { ConnectionManager, type RawResultSet } from '@main/services/connection-manager';
import { MetadataStore } from '@main/services/metadata-store';
import type { Security } from '@main/services/security';
import { FavoritesStore } from '@main/services/favorites-store';

/** 收集所有注册的 handler。 */
function makeIpcMainMock() {
  const handlers = new Map<string, (e: unknown, arg: unknown) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (e: unknown, arg: unknown) => unknown) => {
      handlers.set(channel, fn);
    }),
  };
  return { ipcMain, handlers };
}

function makeConnectionManager(): ConnectionManager {
  // 注入假 mysql2 工厂，executeMany 返回单结果集
  const factory = {
    createPool: () => ({
      getConnection: async () => ({
        execute: async () => [[], []],
        query: async () => [[], []],
        release: () => {},
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
      }),
      end: async () => {},
      query: async () => [[], []],
    }),
    createConnection: async () => ({
      query: async () => [[], []],
      execute: async () => [[], []],
      release: () => {},
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      end: async () => {},
    }),
  } as unknown as ConstructorParameters<typeof ConnectionManager>[0];
  return new ConnectionManager(factory);
}

describe('registerIpc', () => {
  let handlers: Map<string, (e: unknown, arg: unknown) => unknown>;
  let deps: IpcDeps;
  let metadataStore: MetadataStore;

  beforeEach(() => {
    const { ipcMain, handlers: h } = makeIpcMainMock();
    handlers = h;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstudio-ipc-'));
    const dbFile = path.join(tmp, 'meta.db');
    metadataStore = new MetadataStore({ dbPath: dbFile, security: makeSecurity() });
    const cm = makeConnectionManager();
    deps = {
      connectionManager: cm,
      metadataStore,
      favoritesStore: new FavoritesStore(path.join(tmp, 'queries')),
    };
    registerIpc(deps, ipcMain as never);
  });

  it('注册了全部 channel', () => {
    expect(handlers.size).toBeGreaterThanOrEqual(20);
    expect(handlers.has('app:ping')).toBe(true);
    expect(handlers.has('connections:list')).toBe(true);
    expect(handlers.has('query:execute')).toBe(true);
  });

  it('app:ping 成功', async () => {
    const fn = handlers.get('app:ping')!;
    const res = await fn(null, undefined);
    expect(res).toEqual({ ok: true, data: 'pong' });
  });

  it('connections:list 返回摘要（无密码）', async () => {
    metadataStore.saveConnection({ name: 'c1', host: 'h', port: 3306, user: 'u', password: 'p', charset: 'utf8mb4' });
    const fn = handlers.get('connections:list')!;
    const res = await fn(null, undefined) as { ok: true; data: { password?: string }[] };
    expect(res.ok).toBe(true);
    expect(res.data[0].password).toBeUndefined();
  });

  it('connections:get 不存在抛错 → {ok:false}', async () => {
    const fn = handlers.get('connections:get')!;
    const res = (await fn(null, { id: 'nope' })) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('连接不存在');
  });

  it('query:execute 执行并自动记录历史', async () => {
    // 准备一个连接 + 让 executeMany 返回数据
    const conn = metadataStore.saveConnection({ name: 'c1', host: 'h', port: 3306, user: 'u', password: 'p', charset: 'utf8mb4' });
    // 覆盖 metadataStore.getConnectionConfig 的解密配置
    // 用 fake connectionManager.executeMany 返回行
    const fakeCm = deps.connectionManager as unknown as { executeMany: (c: unknown, sql: string) => Promise<RawResultSet[]> };
    fakeCm.executeMany = async () => [{ rows: [{ id: 1 }], fields: [{ name: 'id' }], affectedRows: 0, isWrite: false }];

    const fn = handlers.get('query:execute')!;
    const res = (await fn(null, { connectionId: conn.id, sql: 'SELECT 1' })) as { ok: true; data: { resultSets: { rows: unknown[] }[] } };
    expect(res.ok).toBe(true);
    expect(res.data.resultSets[0].rows).toHaveLength(1);
    // 历史应被记录
    const hist = (await (handlers.get('history:list')!(null, undefined) as Promise<unknown>)) as { ok: true; data: unknown[] };
    expect(hist.data.length).toBe(1);
  });

  it('query:execute 异常被包装为 {ok:false}', async () => {
    const conn = metadataStore.saveConnection({ name: 'c1', host: 'h', port: 3306, user: 'u', password: 'p', charset: 'utf8mb4' });
    const fakeCm = deps.connectionManager as unknown as { executeMany: (c: unknown, sql: string) => Promise<RawResultSet[]> };
    fakeCm.executeMany = async () => {
      throw new Error('语法错误 near SELECT');
    };
    const fn = handlers.get('query:execute')!;
    const res = (await fn(null, { connectionId: conn.id, sql: 'BAD' })) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('语法错误');
  });

  it('favorites:save / list 走文件库', async () => {
    const saveFn = handlers.get('favorites:save')!;
    const res = (await saveFn(null, { name: 'q1', sql: 'SELECT 1' })) as { ok: true; data: { name: string } };
    expect(res.ok).toBe(true);
    expect(res.data.name).toBe('q1');
    const listFn = handlers.get('favorites:list')!;
    const listRes = (await listFn(null, undefined)) as { ok: true; data: { name: string }[] };
    expect(listRes.data.map((f) => f.name)).toContain('q1');
  });
});

/** 简易 security mock（与任务 3 测试一致）。 */
function makeSecurity(): Security {
  return {
    encrypt: (v: string) => `enc:${v}`,
    decrypt: (v: string) => v.replace(/^enc:/, ''),
    isEncryptionAvailable: () => true,
  } as unknown as Security;
}
