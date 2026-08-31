/**
 * 对象浏览器（任务 8 ui-connection）。
 * 树：连接 → 库 → 表/视图 → 字段；点击表可请求数据预览。
 * 通过 window.sqlStudio 的 schema:* 通道加载（主进程读 schema 缓存 + 真实库）。
 *
 * 注意：`schema:databases` 返回 string[]（库名），渲染进程在此包装为 DbNode
 * （带懒加载的 tables），符合类型唯一来源（铁律 R5）——不复制主进程类型，
 * 仅组合共享类型 TableMeta/ColumnMeta。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Table2, Eye, KeyRound, RefreshCw, PlayCircle, AlertTriangle, Search, X } from 'lucide-react';
import type { ColumnMeta, TableMeta } from '@shared/types';

export interface ObjectExplorerProps {
  connectionId: string;
  onPreviewTable?: (database: string, table: string) => void;
  /** 双击表时自动生成 SELECT 语句（任务 8 验收：双击表生成 SELECT 到编辑器）。 */
  onOpenTable?: (database: string, table: string) => void;
  /** 双击字段时插入到编辑器光标处（体验优化 §14）。 */
  onInsertColumn?: (database: string, table: string, column: string) => void;
  /** 右键菜单查看 DDL（SHOW CREATE TABLE 结果）。 */
  onDdlTable?: (database: string, table: string) => void;
}

/** 表节点：共享类型 TableMeta + 懒加载的字段列表（columns 不在 TableMeta 内，避免污染唯一来源）。 */
type TableNode = TableMeta & { columns?: ColumnMeta[]; loadError?: string };
/** 库节点：库名 + 懒加载的表列表。 */
type DbNode = { name: string; tables?: TableNode[]; loadError?: string };

/** 筛选关键词长度达到该值才触发"预载所有库的表"跨库搜索（避免空搜索打太多请求）。 */
const SEARCH_LOAD_THRESHOLD = 2;

export function ObjectExplorer({ connectionId, onPreviewTable, onOpenTable, onInsertColumn, onDdlTable }: ObjectExplorerProps) {
  const [databases, setDatabases] = useState<DbNode[]>([]);
  const [expandedDb, setExpandedDb] = useState<string | null>(null);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const requestIdRef = useRef(0);
  /** 是否已为当前关键词触发过全库表预载（避免重复请求）。 */
  const preloadedForRef = useRef('');
  /** 右键菜单状态。 */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; db: string; table: string } | null>(null);

  /** 加载数据库列表（可重试：初始加载与错误重试共用）。 */
  const loadDatabases = async () => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setExpandedDb(null);
    setExpandedTable(null);
    try {
      const names = await window.sqlStudio['schema:databases']({ connectionId });
      if (reqId !== requestIdRef.current) return;
      setDatabases(names.map((name) => ({ name })));
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : '加载库失败');
    } finally {
      if (reqId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadDatabases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  /** 确保某库已加载表（返回是否已就绪）。 */
  const ensureTablesLoaded = async (db: string): Promise<boolean> => {
    const node = databases.find((d) => d.name === db);
    if (node?.tables) return true;
    try {
      const tables = await window.sqlStudio['schema:tables']({ connectionId, database: db });
      const reqId = requestIdRef.current;
      setDatabases((dbs) => dbs.map((d) => (d.name === db ? { ...d, tables, loadError: undefined } : d)));
      void reqId;
      return true;
    } catch {
      setDatabases((dbs) =>
        dbs.map((d) => (d.name === db ? { ...d, loadError: '加载表失败' } : d)),
      );
      return false;
    }
  };

  /** 筛选关键词变化：长度达标时预载所有库的表（便于跨库模糊搜索）。 */
  useEffect(() => {
    const kw = filter.trim();
    if (kw.length < SEARCH_LOAD_THRESHOLD) {
      preloadedForRef.current = '';
      return;
    }
    if (preloadedForRef.current === kw) return;
    preloadedForRef.current = kw;
    // 对所有还没加载表的库并行拉表
    const pending = databases.filter((d) => !d.tables).map((d) => ensureTablesLoaded(d.name));
    if (pending.length) void Promise.all(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, databases.length, connectionId]);

  const loadTables = async (db: string) => {
    const reqId = ++requestIdRef.current;
    try {
      const tables = await window.sqlStudio['schema:tables']({ connectionId, database: db });
      if (reqId !== requestIdRef.current) return;
      setDatabases((dbs) => dbs.map((d) => (d.name === db ? { ...d, tables, loadError: undefined } : d)));
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      // 子级加载失败只标记该库，不覆盖已加载的整棵树
      setDatabases((dbs) =>
        dbs.map((d) => (d.name === db ? { ...d, loadError: err instanceof Error ? err.message : `加载表失败：${db}` } : d)),
      );
    }
  };

  const loadColumns = async (db: string, table: string) => {
    const reqId = ++requestIdRef.current;
    try {
      const columns = await window.sqlStudio['schema:columns']({
        connectionId,
        database: db,
        table,
      });
      if (reqId !== requestIdRef.current) return;
      setDatabases((dbs) =>
        dbs.map((d) => {
          if (d.name !== db || !d.tables) return d;
          return {
            ...d,
            tables: d.tables.map((t) => (t.name === table ? { ...t, columns, loadError: undefined } : t)),
          };
        }),
      );
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      // 子级加载失败只标记该表，不覆盖整棵树
      setDatabases((dbs) =>
        dbs.map((d) => {
          if (d.name !== db || !d.tables) return d;
          return {
            ...d,
            tables: d.tables.map((t) => (t.name === table ? { ...t, loadError: err instanceof Error ? err.message : `加载字段失败：${db}.${table}` } : t)),
          };
        }),
      );
    }
  };

  const toggleDb = (dbNode: DbNode) => {
    const next = expandedDb === dbNode.name ? null : dbNode.name;
    setExpandedDb(next);
    if (next && !dbNode.tables) void loadTables(dbNode.name);
  };

  const toggleTable = (db: string, t: TableNode) => {
    const key = `${db}.${t.name}`;
    const next = expandedTable === key ? null : key;
    setExpandedTable(next);
    if (next && !t.columns) void loadColumns(db, t.name);
  };

  const handleContextMenu = (e: React.MouseEvent, db: string, table: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, db, table });
  };

  const closeContextMenu = () => setContextMenu(null);

  /** 按关键词过滤：库名或表名模糊匹配（大小写不敏感）。 */
  const kw = filter.trim().toLowerCase();
  const filteredDatabases: DbNode[] = useMemo(() => {
    if (!kw) return databases;
    const out: DbNode[] = [];
    for (const db of databases) {
      const dbMatch = db.name.toLowerCase().includes(kw);
      const tables = db.tables?.filter((t) => t.name.toLowerCase().includes(kw));
      const matched = dbMatch || (tables && tables.length > 0);
      if (!matched) continue;
      out.push({ ...db, tables: dbMatch ? db.tables : tables });
    }
    return out;
  }, [databases, kw]);

  /** 是否因筛选而"虚拟展开"（命中即展开，无需手动点库）。 */
  const isFilterExpanded = (dbName: string): boolean => !!kw && (expandedDb === dbName || kw.length >= SEARCH_LOAD_THRESHOLD);

  if (error) {
    return (
      <div className="explorer error">
        <span>{error}</span>
        <button className="explorer-retry" onClick={() => void loadDatabases()} title="重新加载">
          <RefreshCw size={13} /> 重试
        </button>
      </div>
    );
  }

  return (
    <div className="explorer">
      <div className="explorer-header">
        <h3>对象浏览器</h3>
        {loading && <span className="explorer-loading">加载中…</span>}
      </div>
      {/* 筛选框（2026-08-31 新增：表名+库名模糊匹配） */}
      <div className="explorer-filter">
        <Search size={13} className="explorer-filter-icon" />
        <input
          className="explorer-filter-input"
          placeholder="搜索表名 / 库名…"
          aria-label="搜索表或库"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="explorer-filter-clear" onClick={() => setFilter('')} title="清空">
            <X size={12} />
          </button>
        )}
      </div>
      <ul className="db-list">
        {filteredDatabases.map((dbNode) => (
          <li key={dbNode.name}>
            <div
              className={`db-item${expandedDb === dbNode.name ? ' expanded' : ''}`}
              onClick={() => toggleDb(dbNode)}
            >
              <span className="tree-arrow">
                {expandedDb === dbNode.name
                  ? <ChevronDown size={14} />
                  : <ChevronRight size={14} />}
              </span>
              <Database size={14} className="db-icon" />
              <span className="db-name">{dbNode.name}</span>
              {kw && !dbNode.tables && <span className="explorer-filter-hint">（搜索中…）</span>}
            </div>
            {dbNode.loadError && (
              <div className="explorer-node-error" title={dbNode.loadError}>
                <AlertTriangle size={11} /> {dbNode.loadError}
                <button className="explorer-node-retry" onClick={(e) => { e.stopPropagation(); void loadTables(dbNode.name); }}>
                  <RefreshCw size={11} /> 重试
                </button>
              </div>
            )}
            {(expandedDb === dbNode.name || isFilterExpanded(dbNode.name)) && dbNode.tables && (
              <ul className="table-list">
                {dbNode.tables.map((t) => (
                  <li key={t.name}>
                    <div
                      className={`table-item${expandedTable === `${dbNode.name}.${t.name}` ? ' expanded' : ''}`}
                      onClick={() => toggleTable(dbNode.name, t)}
                      onDoubleClick={() => onOpenTable?.(dbNode.name, t.name)}
                      onContextMenu={(e) => handleContextMenu(e, dbNode.name, t.name)}
                      title={t.comment || t.name}
                    >
                      <span className="tree-arrow">
                        {expandedTable === `${dbNode.name}.${t.name}`
                          ? <ChevronDown size={14} />
                          : <ChevronRight size={14} />}
                      </span>
                      {t.isView ? <Eye size={14} className="view-icon" /> : <Table2 size={14} className="table-icon" />}
                      <span className="table-name">{t.name}</span>
                      {onPreviewTable && (
                        <button
                          className="preview"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPreviewTable(dbNode.name, t.name);
                          }}
                          title="数据预览"
                        >
                          <PlayCircle size={13} /> 预览
                        </button>
                      )}
                    </div>
                    {t.loadError && (
                      <div className="explorer-node-error" title={t.loadError}>
                        <AlertTriangle size={11} /> {t.loadError}
                        <button className="explorer-node-retry" onClick={(e) => { e.stopPropagation(); void loadColumns(dbNode.name, t.name); }}>
                          <RefreshCw size={11} /> 重试
                        </button>
                      </div>
                    )}
                    {expandedTable === `${dbNode.name}.${t.name}` && t.columns && (
                      <ul className="col-list">
                        {t.columns.map((c) => (
                          <li
                            key={c.name}
                            className={c.isPrimary ? 'pk' : ''}
                            title={c.comment || `双击插入 \`${c.name}\``}
                            onDoubleClick={() => onInsertColumn?.(dbNode.name, t.name, c.name)}
                          >
                            <span className="col-key">{c.isPrimary ? <KeyRound size={12} /> : null}</span>
                            <span className="col-name">{c.name}</span>
                            <em>{c.type}</em>
                            {c.comment ? <span className="col-comment">{c.comment}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {databases.length === 0 && !loading && !error && (
          <li className="explorer-empty">该连接无可见数据库</li>
        )}
        {kw && filteredDatabases.length === 0 && !loading && (
          <li className="explorer-empty">未找到匹配「{filter}」的库或表</li>
        )}
      </ul>
      {contextMenu && (
        <>
          <div className="context-backdrop" onClick={closeContextMenu} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button
              className="context-item"
              onClick={() => {
                closeContextMenu();
                if (contextMenu) onPreviewTable?.(contextMenu.db, contextMenu.table);
              }}
            >
              <PlayCircle size={14} /> 数据预览
            </button>
            <button
              className="context-item"
              onClick={() => {
                closeContextMenu();
                if (contextMenu) onDdlTable?.(contextMenu.db, contextMenu.table);
              }}
            >
              查看 DDL
            </button>
            <button
              className="context-item"
              onClick={() => {
                closeContextMenu();
                if (contextMenu) void loadColumns(contextMenu.db, contextMenu.table);
              }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </>
      )}
    </div>
  );
}