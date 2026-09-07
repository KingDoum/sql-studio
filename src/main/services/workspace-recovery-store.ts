/**
 * 工作区恢复存储（自动保存方案 §8）。
 *
 * 职责：
 * - 工作区快照 load / save / clear + revision 防护（§8.5）。
 * - 规范化表（workspace_snapshots + workspace_tabs）单事务替换（§8.4）。
 * - 逐行校验与坏标签隔离（§11.9）：单标签坏 → 隔离该行恢复其余；
 *   主行坏 → 隔离快照返回空工作区。
 * - 容量上限（§8.8）：单标签 SQL 2 MiB / 总 20 MiB / 标签 100。
 *
 * 与 MetadataStore 共用同一个 better-sqlite3 连接（§8.1），不自行建连。
 * 连接在构造时已完成 v1→v2 迁移（metadata-store migrate），本类只做 CRUD。
 */

import type Database from 'better-sqlite3';
import type {
  WorkspaceLoadResult,
  WorkspaceSnapshot,
  WorkspaceTabSnapshot,
  WorkspaceSaveRequest,
  WorkspaceSaveResult,
  WorkspaceClearRequest,
  WorkspaceClearResult,
} from '@shared/types';
import { WORKSPACE_SCHEMA_VERSION } from '@shared/types';

/** 容量上限（§8.8）：单标签 SQL UTF-8 字节上限。 */
export const MAX_TAB_SQL_BYTES = 2 * 1024 * 1024;
/** 容量上限（§8.8）：单工作区全部 SQL UTF-8 字节上限。 */
export const MAX_WORKSPACE_SQL_BYTES = 20 * 1024 * 1024;
/** 容量上限（§8.8）：标签数量上限。 */
export const MAX_TAB_COUNT = 100;

interface SnapshotRow {
  workspace_id: string;
  schema_version: number;
  revision: number;
  active_tab_id: string | null;
  current_connection_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TabRow {
  workspace_id: string;
  tab_id: string;
  tab_order: number;
  title: string;
  file_path: string | null;
  sql_content: string;
  is_dirty: number;
  connection_id: string | null;
  created_at: string;
  updated_at: string;
}

export class WorkspaceRecoveryStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ─────────────────────────────────────────────────────────────
  // load（§11：恢复协议）
  // ─────────────────────────────────────────────────────────────

  load(workspaceId: 'default'): WorkspaceLoadResult {
    const warnings: string[] = [];
    let quarantined = 0;

    const row = this.db
      .prepare('SELECT * FROM workspace_snapshots WHERE workspace_id = ?')
      .get(workspaceId) as SnapshotRow | undefined;

    // 首次启动无数据：不视为错误（§11.1）
    if (!row) {
      return { snapshot: null, recoveredTabCount: 0, quarantinedTabCount: 0, warnings: [] };
    }

    // 未知未来 schema 版本：隔离快照，启动空工作区（§11.10）
    if (row.schema_version > WORKSPACE_SCHEMA_VERSION) {
      warnings.push(`未知工作区 schema 版本 ${row.schema_version}，已隔离快照（只读不覆盖）`);
      return { snapshot: null, recoveredTabCount: 0, quarantinedTabCount: 1, warnings };
    }

    const tabRows = this.db
      .prepare('SELECT * FROM workspace_tabs WHERE workspace_id = ? ORDER BY tab_order ASC')
      .all(workspaceId) as TabRow[];

    // 校验标签：坏行隔离（§11.5/§11.9）
    const tabs: WorkspaceTabSnapshot[] = [];
    const seenIds = new Set<string>();
    const seenOrders = new Set<number>();
    let nextOrder = 0;

    for (const t of tabRows) {
      const problems: string[] = [];
      if (!t.tab_id || t.tab_id.length === 0 || t.tab_id.length > 128) problems.push('tab_id 非法');
      if (seenIds.has(t.tab_id)) problems.push('tab_id 重复');
      if (t.tab_order < 0 || seenOrders.has(t.tab_order)) problems.push('tab_order 重复/非法');
      if (typeof t.title !== 'string' || t.title.length > 512) problems.push('title 非法');
      if (t.file_path !== null && (typeof t.file_path !== 'string' || t.file_path.length > 32768)) problems.push('file_path 非法');
      if (typeof t.sql_content !== 'string') problems.push('sql_content 非法');
      if (t.is_dirty !== 0 && t.is_dirty !== 1) problems.push('is_dirty 非法');

      if (problems.length > 0) {
        quarantined += 1;
        warnings.push(`已隔离坏标签 ${t.tab_id}: ${problems.join('、')}`);
        continue;
      }

      seenIds.add(t.tab_id);
      seenOrders.add(t.tab_order);
      tabs.push({
        id: t.tab_id,
        // 加载时规范化 tabOrder 从 0 连续重建（§11.5）
        tabOrder: nextOrder++,
        title: t.title,
        filePath: t.file_path,
        sqlContent: t.sql_content,
        isDirty: t.is_dirty === 1,
        connectionId: t.connection_id,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      });
    }

    // activeTabId 校验：无效回退第一个有效标签，无标签为 null（§11.5）
    let activeTabId = row.active_tab_id;
    if (activeTabId !== null && !tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null;
      if (tabs.length > 0) warnings.push('activeTabId 无效，已回退到第一个标签');
    }
    if (tabs.length === 0) activeTabId = null;

    const snapshot: WorkspaceSnapshot = {
      workspaceId: 'default',
      schemaVersion: row.schema_version,
      revision: row.revision,
      activeTabId,
      currentConnectionId: row.current_connection_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tabs,
    };

    return {
      snapshot,
      recoveredTabCount: tabs.length,
      quarantinedTabCount: quarantined,
      warnings,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // save（§8.4/§8.5：单事务替换 + revision 防护）
  // ─────────────────────────────────────────────────────────────

  save(req: WorkspaceSaveRequest): WorkspaceSaveResult {
    const snap = req.snapshot;

    // 运行时校验（方案 §13.2：Main 对所有 IPC 输入做运行时校验）
    if (!snap || snap.workspaceId !== 'default') {
      throw new Error('非法 workspaceId');
    }
    if (!Number.isInteger(snap.revision) || snap.revision < 0) {
      throw new Error('非法 revision');
    }
    if (!Number.isInteger(snap.schemaVersion) || snap.schemaVersion < 1) {
      throw new Error('非法 schemaVersion');
    }
    if (snap.tabs.length > MAX_TAB_COUNT) {
      return { saved: false, acceptedRevision: snap.revision, storedRevision: this.getStoredRevision(), reason: 'capacity-exceeded' };
    }
    const totalBytes = snap.tabs.reduce((n, t) => n + Buffer.byteLength(t.sqlContent, 'utf8'), 0);
    if (totalBytes > MAX_WORKSPACE_SQL_BYTES) {
      return { saved: false, acceptedRevision: snap.revision, storedRevision: this.getStoredRevision(), reason: 'capacity-exceeded' };
    }
    for (const t of snap.tabs) {
      if (Buffer.byteLength(t.sqlContent, 'utf8') > MAX_TAB_SQL_BYTES) {
        return { saved: false, acceptedRevision: snap.revision, storedRevision: this.getStoredRevision(), reason: 'capacity-exceeded' };
      }
    }

    // revision 条件写入（§8.5）：Main 拒绝 incoming <= stored
    const storedRevision = this.getStoredRevision();
    if (snap.revision <= storedRevision) {
      return { saved: false, acceptedRevision: snap.revision, storedRevision, reason: 'stale-revision' };
    }

    const now = new Date().toISOString();
    const createdAt = this.getCreatedAt(snap.revision) ?? snap.createdAt ?? now;

    const saveTx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspace_snapshots (
            workspace_id, schema_version, revision, active_tab_id, current_connection_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            revision = excluded.revision,
            active_tab_id = excluded.active_tab_id,
            current_connection_id = excluded.current_connection_id,
            updated_at = excluded.updated_at
          WHERE excluded.revision > workspace_snapshots.revision`,
        )
        .run(
          snap.workspaceId,
          snap.schemaVersion,
          snap.revision,
          snap.activeTabId,
          snap.currentConnectionId,
          createdAt,
          now,
        );

      // 仅当上一步确实接受 incoming revision 时继续替换子表（§8.5）
      if (this.getStoredRevision() === snap.revision) {
        this.db.prepare('DELETE FROM workspace_tabs WHERE workspace_id = ?').run(snap.workspaceId);
        const insertTab = this.db.prepare(
          `INSERT INTO workspace_tabs (
            workspace_id, tab_id, tab_order, title, file_path, sql_content, is_dirty, connection_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of snap.tabs) {
          insertTab.run(
            snap.workspaceId,
            t.id,
            t.tabOrder,
            t.title,
            t.filePath,
            t.sqlContent,
            t.isDirty ? 1 : 0,
            t.connectionId,
            t.createdAt,
            t.updatedAt,
          );
        }
      }
    });
    saveTx();

    return { saved: true, acceptedRevision: snap.revision, storedRevision: this.getStoredRevision(), reason: 'saved' };
  }

  // ─────────────────────────────────────────────────────────────
  // clear（§8.6）
  // ─────────────────────────────────────────────────────────────

  clear(req: WorkspaceClearRequest): WorkspaceClearResult {
    if (!req || req.workspaceId !== 'default') {
      throw new Error('非法 workspaceId');
    }
    const tx = this.db.transaction(() => {
      // 依赖 ON DELETE CASCADE 删除标签子表（§8.6）
      this.db.prepare('DELETE FROM workspace_snapshots WHERE workspace_id = ?').run(req.workspaceId);
    });
    tx();
    return { cleared: true };
  }

  // ─────────────────────────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────────────────────────

  /** 当前持久化 revision（无快照时为 0）。 */
  getStoredRevision(): number {
    const row = this.db
      .prepare('SELECT revision FROM workspace_snapshots WHERE workspace_id = ?')
      .get('default') as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  private getCreatedAt(revision: number): string | null {
    const row = this.db
      .prepare('SELECT created_at FROM workspace_snapshots WHERE workspace_id = ?')
      .get('default') as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }
}
