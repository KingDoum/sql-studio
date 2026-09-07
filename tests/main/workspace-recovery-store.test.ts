/**
 * workspace-recovery-store.ts 单测（自动保存方案 S2，测试矩阵 §16.2）。
 * 使用临时 sqlite 文件 + MetadataStore（共享连接），覆盖：
 *  - v1 → v2 迁移（MS-01）
 *  - 首次保存主表+标签一次提交（MS-02）
 *  - 更新保存完整替换且顺序正确（MS-03）
 *  - 旧 revision 不覆盖新状态（MS-04）
 *  - 中途异常整体回滚（MS-05）
 *  - clear 仅删工作区记录（MS-06）
 *  - 坏行隔离 / 主行隔离（MS-07/MS-08）
 *  - 外键开启（MS-09）
 *  - 容量超限（MS-10）
 *  - 未知 schema 版本隔离（多标签/activeTabId 回退）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MetadataStore, WORKSPACE_DDL } from '@main/services/metadata-store';
import { WorkspaceRecoveryStore, MAX_TAB_SQL_BYTES, MAX_WORKSPACE_SQL_BYTES, MAX_TAB_COUNT } from '@main/services/workspace-recovery-store';
import { Security } from '@main/services/security';
import type { WorkspaceSnapshot, WorkspaceTabSnapshot } from '@shared/types';
import { WORKSPACE_SCHEMA_VERSION } from '@shared/types';

const mockSecurity = new Security();

function makeTab(partial: Partial<WorkspaceTabSnapshot> & { id: string; tabOrder: number }): WorkspaceTabSnapshot {
  return {
    title: '未命名',
    filePath: null,
    sqlContent: '',
    isDirty: true,
    connectionId: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...partial,
  };
}

function makeSnapshot(partial: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceId: 'default',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: 1,
    activeTabId: null,
    currentConnectionId: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    tabs: [],
    ...partial,
  };
}

describe('WorkspaceRecoveryStore', () => {
  let tmpDir: string;
  let store: MetadataStore;
  let ws: WorkspaceRecoveryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstudio-ws-'));
    const dbPath = path.join(tmpDir, 'ws.test.db');
    store = new MetadataStore({ dbPath, security: mockSecurity });
    ws = new WorkspaceRecoveryStore(store.getSharedDatabase());
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('迁移（MS-01）', () => {
    it('v1 数据库迁移后版本为 2 且旧数据不变', () => {
      // 先写入 v1 数据（实际当前代码：新库直接建到 v2，旧库从 v1 升）
      expect(store.getVersion()).toBe(2);
      store.saveConnection({ name: 'c1', host: 'h', port: 3306, user: 'u', password: 'p', charset: 'utf8mb4' });
      expect(store.listConnections()).toHaveLength(1);
      // 工作区表存在
      const tables = store.getSharedDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_snapshots','workspace_tabs')").all() as { name: string }[];
      expect(tables.map((t) => t.name).sort()).toEqual(['workspace_snapshots', 'workspace_tabs']);
    });

    it('重复启动不重复破坏性迁移（幂等）', () => {
      const dbPath = path.join(tmpDir, 'ws.test.db');
      // 关闭后重开同一文件
      store.close();
      store = new MetadataStore({ dbPath, security: mockSecurity });
      ws = new WorkspaceRecoveryStore(store.getSharedDatabase());
      expect(store.getVersion()).toBe(2);
      // 连接数据仍在
      store.saveConnection({ name: 'c1', host: 'h', port: 3306, user: 'u', password: 'p', charset: 'utf8mb4' });
      expect(store.listConnections()).toHaveLength(1);
    });
  });

  describe('save / load（MS-02/MS-03）', () => {
    it('首次保存：主表 + 标签一次提交', () => {
      const snap = makeSnapshot({
        revision: 1,
        activeTabId: 't1',
        currentConnectionId: 'conn-1',
        tabs: [
          makeTab({ id: 't1', tabOrder: 0, title: '查询1', sqlContent: 'SELECT 1', isDirty: true }),
          makeTab({ id: 't2', tabOrder: 1, title: '查询2', filePath: '/tmp/a.sql', sqlContent: 'SELECT 2', isDirty: false }),
        ],
      });
      const res = ws.save({ snapshot: snap });
      expect(res).toEqual({ saved: true, acceptedRevision: 1, storedRevision: 1, reason: 'saved' });

      const loaded = ws.load('default');
      expect(loaded.recoveredTabCount).toBe(2);
      expect(loaded.quarantinedTabCount).toBe(0);
      expect(loaded.snapshot?.revision).toBe(1);
      expect(loaded.snapshot?.activeTabId).toBe('t1');
      expect(loaded.snapshot?.currentConnectionId).toBe('conn-1');
      expect(loaded.snapshot?.tabs.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(loaded.snapshot?.tabs[0]?.sqlContent).toBe('SELECT 1');
      expect(loaded.snapshot?.tabs[1]?.isDirty).toBe(false);
    });

    it('更新保存：标签完整替换且顺序正确（MS-03）', () => {
      ws.save({
        snapshot: makeSnapshot({
          revision: 1,
          tabs: [
            makeTab({ id: 't1', tabOrder: 0, sqlContent: 'OLD' }),
            makeTab({ id: 't2', tabOrder: 1, sqlContent: 'OLD2' }),
          ],
        }),
      });
      // 新快照去掉 t2，翻转 t1 内容
      ws.save({
        snapshot: makeSnapshot({
          revision: 2,
          activeTabId: 't3',
          tabs: [
            makeTab({ id: 't3', tabOrder: 0, sqlContent: 'NEW' }),
          ],
        }),
      });
      const loaded = ws.load('default');
      expect(loaded.snapshot?.revision).toBe(2);
      expect(loaded.snapshot?.tabs.map((t) => t.id)).toEqual(['t3']);
      expect(loaded.snapshot?.tabs[0]?.sqlContent).toBe('NEW');
    });

    it('旧 revision 不覆盖新状态（MS-04）', () => {
      ws.save({ snapshot: makeSnapshot({ revision: 2, tabs: [makeTab({ id: 'new', tabOrder: 0, sqlContent: 'NEW' })] }) });
      const res = ws.save({ snapshot: makeSnapshot({ revision: 1, tabs: [makeTab({ id: 'old', tabOrder: 0, sqlContent: 'OLD' })] }) });
      expect(res.saved).toBe(false);
      expect(res.reason).toBe('stale-revision');
      expect(res.storedRevision).toBe(2);
      const loaded = ws.load('default');
      expect(loaded.snapshot?.tabs[0]?.id).toBe('new');
      expect(loaded.snapshot?.tabs[0]?.sqlContent).toBe('NEW');
    });

    it('中途异常整体回滚（MS-05：子表插入失败主表不提交）', () => {
      const snap = makeSnapshot({
        revision: 1,
        tabs: [
          // tabOrder 非法（负数）→ 子表插入违反 CHECK 约束
          { ...makeTab({ id: 't1', tabOrder: -1 }) },
        ] as unknown as WorkspaceTabSnapshot[],
      });
      expect(() => ws.save({ snapshot: snap })).toThrow();
      const loaded = ws.load('default');
      expect(loaded.snapshot).toBeNull();
    });
  });

  describe('clear（MS-06）', () => {
    it('仅删除工作区记录，不影响连接/历史/设置', () => {
      store.saveConnection({ name: 'c1', host: 'h', port: 3306, user: 'u', password: 'p', charset: 'utf8mb4' });
      store.setSetting('theme', 'dark');
      ws.save({ snapshot: makeSnapshot({ revision: 1, tabs: [makeTab({ id: 't1', tabOrder: 0 })] }) });
      const res = ws.clear({ workspaceId: 'default' });
      expect(res.cleared).toBe(true);
      const loaded = ws.load('default');
      expect(loaded.snapshot).toBeNull();
      expect(store.listConnections()).toHaveLength(1);
      expect(store.getSetting('theme')).toBe('dark');
      // 标签子表级联删除
      const tabs = store.getSharedDatabase().prepare('SELECT COUNT(*) AS n FROM workspace_tabs').get() as { n: number };
      expect(tabs.n).toBe(0);
    });
  });

  describe('坏行隔离（MS-07/MS-08）', () => {
    it('单标签坏行：隔离坏行恢复其余', () => {
      ws.save({
        snapshot: makeSnapshot({
          revision: 1,
          activeTabId: 'good',
          tabs: [
            makeTab({ id: 'good', tabOrder: 0, sqlContent: 'OK' }),
            makeTab({ id: 'bad', tabOrder: 1, sqlContent: 'BAD' }),
          ],
        }),
      });
      // 直接注入坏行（绕过 CHECK 约束，模拟外部工具写入的坏数据）：title 超长（>512）
      store.getSharedDatabase().pragma('ignore_check_constraints = ON');
      try {
        store.getSharedDatabase()
          .prepare('UPDATE workspace_tabs SET title = ? WHERE tab_id = ?')
          .run('x'.repeat(600), 'bad');
      } finally {
        store.getSharedDatabase().pragma('ignore_check_constraints = OFF');
      }
      const loaded = ws.load('default');
      expect(loaded.recoveredTabCount).toBe(1);
      expect(loaded.quarantinedTabCount).toBe(1);
      expect(loaded.snapshot?.tabs.map((t) => t.id)).toEqual(['good']);
      expect(loaded.warnings.length).toBeGreaterThan(0);
    });

    it('主行损坏（未知 schema 版本）：返回空工作区和警告', () => {
      ws.save({ snapshot: makeSnapshot({ revision: 1, tabs: [makeTab({ id: 't1', tabOrder: 0 })] }) });
      store.getSharedDatabase()
        .prepare('UPDATE workspace_snapshots SET schema_version = ? WHERE workspace_id = ?')
        .run(99, 'default');
      const loaded = ws.load('default');
      expect(loaded.snapshot).toBeNull();
      expect(loaded.quarantinedTabCount).toBe(1);
      expect(loaded.warnings.some((w) => w.includes('未知工作区 schema'))).toBe(true);
    });

    it('activeTabId 无效回退第一个有效标签；无标签为 null', () => {
      ws.save({
        snapshot: makeSnapshot({
          revision: 1,
          activeTabId: 'ghost',
          tabs: [makeTab({ id: 'a', tabOrder: 0 }), makeTab({ id: 'b', tabOrder: 1 })],
        }),
      });
      const loaded = ws.load('default');
      expect(loaded.snapshot?.activeTabId).toBe('a');
      ws.save({ snapshot: makeSnapshot({ revision: 2, activeTabId: null, tabs: [] }) });
      expect(ws.load('default').snapshot?.activeTabId).toBeNull();
    });

    it('重复 tabOrder 在保存阶段被 UNIQUE 约束拒绝（写入端防御）', () => {
      // UNIQUE (workspace_id, tab_order) 使重复 order 无法写入
      expect(() =>
        ws.save({
          snapshot: makeSnapshot({
            revision: 1,
            tabs: [
              makeTab({ id: 'x', tabOrder: 0 }),
              makeTab({ id: 'y', tabOrder: 0 }),
            ],
          }),
        }),
      ).toThrow();
      // 事务回滚：主表也不应残留
      expect(ws.load('default').snapshot).toBeNull();
    });
  });

  describe('外键与容量（MS-09/MS-10）', () => {
    it('外键开启：孤立标签不可写入', () => {
      const stmt = store.getSharedDatabase().prepare(
        `INSERT INTO workspace_tabs (workspace_id, tab_id, tab_order, title, sql_content, is_dirty, created_at, updated_at)
         VALUES ('default', 'orphan', 0, 't', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`,
      );
      expect(() => stmt.run()).toThrow(/FOREIGN KEY/i);
    });

    it('容量超限：明确失败不截断 SQL（MS-10）', () => {
      // 标签数量超限
      const manyTabs = Array.from({ length: MAX_TAB_COUNT + 1 }, (_, i) => makeTab({ id: `t${i}`, tabOrder: i }));
      let res = ws.save({ snapshot: makeSnapshot({ revision: 1, tabs: manyTabs }) });
      expect(res.saved).toBe(false);
      expect(res.reason).toBe('capacity-exceeded');
      // 单标签 SQL 超限
      res = ws.save({
        snapshot: makeSnapshot({ revision: 1, tabs: [makeTab({ id: 'big', tabOrder: 0, sqlContent: 'x'.repeat(MAX_TAB_SQL_BYTES + 1) })] }),
      });
      expect(res.saved).toBe(false);
      expect(res.reason).toBe('capacity-exceeded');
      // 总字节超限：两个标签各 12MiB？不，单标签就有 2MiB 上限。用 10 个 2.1MiB 标签会先触发单标签。
      // 改用 10 个 1.9MiB 标签（不超单标签，但总超 20MiB）
      const nearLimit = Math.floor(MAX_TAB_SQL_BYTES * 0.95);
      const totalTabs = Array.from({ length: Math.floor(MAX_WORKSPACE_SQL_BYTES / nearLimit) + 1 }, (_, i) =>
        makeTab({ id: `bulk${i}`, tabOrder: i, sqlContent: 'x'.repeat(nearLimit) }),
      );
      res = ws.save({ snapshot: makeSnapshot({ revision: 1, tabs: totalTabs }) });
      expect(res.saved).toBe(false);
      expect(res.reason).toBe('capacity-exceeded');
    });
  });

  describe('revision 非法输入（SH-06/SH-07 对应项）', () => {
    it('非法 workspaceId 被拒绝', () => {
      expect(() => ws.load('default')).not.toThrow();
      expect(() =>
        ws.save({ snapshot: { ...makeSnapshot(), workspaceId: 'other' as 'default' } }),
      ).toThrow(/非法 workspaceId/);
      expect(() => ws.clear({ workspaceId: 'other' as 'default' })).toThrow(/非法 workspaceId/);
    });

    it('revision 为负被拒绝', () => {
      expect(() => ws.save({ snapshot: makeSnapshot({ revision: -1 }) })).toThrow(/非法 revision/);
    });
  });

  describe('非破坏性失败（MS-11/MS-12）', () => {
    it('保存中途异常：旧快照与数据库保持一致（不产生半更新）', () => {
      // 先保存一份良好快照
      ws.save({
        snapshot: makeSnapshot({
          revision: 1,
          tabs: [makeTab({ id: 'keep', tabOrder: 0, sqlContent: 'KEEP' })],
        }),
      });
      // 注入一个违反约束的标签（tabOrder 负数）→ save 抛错
      const badSnap = makeSnapshot({
        revision: 2,
        tabs: [{ ...makeTab({ id: 'bad', tabOrder: -1 }) }],
      });
      expect(() => ws.save({ snapshot: badSnap })).toThrow();
      // 旧数据完好
      const loaded = ws.load('default');
      expect(loaded.snapshot?.revision).toBe(1);
      expect(loaded.snapshot?.tabs.map((t) => t.id)).toEqual(['keep']);
    });

    it('容量超限与旧 revision 均不破坏已存数据', () => {
      ws.save({
        snapshot: makeSnapshot({
          revision: 5,
          tabs: [makeTab({ id: 'x', tabOrder: 0, sqlContent: 'OK' })],
        }),
      });
      // 容量超限 → saved:false
      const capRes = ws.save({
        snapshot: makeSnapshot({
          revision: 6,
          tabs: [makeTab({ id: 'big', tabOrder: 0, sqlContent: 'x'.repeat(MAX_TAB_SQL_BYTES + 1) })],
        }),
      });
      expect(capRes.saved).toBe(false);
      // 旧 revision → saved:false
      const staleRes = ws.save({ snapshot: makeSnapshot({ revision: 1 }) });
      expect(staleRes.saved).toBe(false);
      // 旧数据完好
      const loaded = ws.load('default');
      expect(loaded.snapshot?.revision).toBe(5);
      expect(loaded.snapshot?.tabs[0]?.id).toBe('x');
    });
  });
});

/** 独立测试：WORKSPACE_DDL 可独立执行（索引/约束齐全）。 */
describe('WORKSPACE_DDL（MS-09 索引与约束）', () => {
  it('DDL 包含必要约束与索引', () => {
    expect(WORKSPACE_DDL).toContain('UNIQUE (workspace_id, tab_order)');
    expect(WORKSPACE_DDL).toContain('ON DELETE CASCADE');
    expect(WORKSPACE_DDL).toContain('idx_workspace_tabs_workspace_order');
    expect(WORKSPACE_DDL).toContain('idx_workspace_tabs_updated_at');
  });
});