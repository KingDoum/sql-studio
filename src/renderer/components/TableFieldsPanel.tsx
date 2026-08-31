/**
 * TableFieldsPanel（右侧表字段导航栏，2026-08-31 新增）。
 *
 * 功能：编辑区右侧竖条，自动识别当前 SQL 用到的表（含子查询、跨库），
 * 点击表 → 展示该表字段 + 注释；多表可手动切换；点击字段 → 插入纯字段名
 * （不带 库.表. 前缀）。
 *
 * 数据来源：extractTablesFromSql 提取表名；每张表经 `schema:columns` IPC 拉字段+注释
 * （组件内缓存，避免重复请求）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Table2, Columns3, Loader2, X, MousePointerClick } from 'lucide-react';
import type { ColumnMeta } from '@shared/types';
import { extractTablesFromSql, type SqlTableRef } from '@renderer/lib/sql-utils';

export interface TableFieldsPanelProps {
  /** 当前标签页 SQL。 */
  sql: string;
  /** 当前连接 id（用于 schema:columns）。 */
  connectionId: string | null;
  /** 当前默认库（用于无库名的表）。 */
  database?: string;
  /** 点击字段 → 插入纯字段名。 */
  onInsertField(field: string): void;
  /** 面板开关（右侧竖条可折叠）。 */
  open?: boolean;
  onToggle?(): void;
}

/** 一张表的字段缓存。 */
interface TableCache {
  key: string;
  ref: SqlTableRef;
  columns: ColumnMeta[];
  loading: boolean;
  error?: string;
}

export function TableFieldsPanel({
  sql,
  connectionId,
  database,
  onInsertField,
  open = true,
  onToggle,
}: TableFieldsPanelProps) {
  // 从 SQL 提取表（去重，保留顺序）
  const tables = useMemo(() => extractTablesFromSql(sql ?? ''), [sql]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [caches, setCaches] = useState<Record<string, TableCache>>({});
  const [width, setWidth] = useState<number | null>(null);
  const widthDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const requestSeq = useRef(0);

  const keyOf = (t: SqlTableRef) => `${t.db ?? ''}.${t.table}`;

  // 表列表变化 → 默认选中第一张（若当前选中已不在列表则重置）
  useEffect(() => {
    if (tables.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((cur) => {
      if (cur && tables.some((t) => keyOf(t) === cur)) return cur;
      return keyOf(tables[0]);
    });
  }, [tables]);

  // 面板宽度拖拽（左边界手柄，200~420px）
  const onWidthStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    widthDragRef.current = { startX: e.clientX, startW: width ?? 220 };
  };
  const onWidthMove = (e: React.PointerEvent) => {
    const d = widthDragRef.current;
    if (!d) return;
    const delta = d.startX - e.clientX; // 向左拖变宽
    const w = Math.min(Math.max(d.startW + delta, 200), 420);
    setWidth(w);
  };
  const onWidthEnd = (e: React.PointerEvent) => {
    widthDragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // 拉取选中表/全部表的字段（按需 + 缓存）
  const loadColumns = async (t: SqlTableRef) => {
    if (!connectionId) return;
    const key = keyOf(t);
    const existing = caches[key];
    if (existing && (existing.columns.length || existing.error)) return;
    const seq = ++requestSeq.current;
    setCaches((c) => ({ ...c, [key]: { ...(c[key] ?? { key, ref: t, columns: [], loading: true }), loading: true, error: undefined } }));
    try {
      const db = t.db ?? database;
      if (!db) {
        setCaches((c) => ({ ...c, [key]: { key, ref: t, columns: [], loading: false, error: '无法确定数据库（未连接或未选库）' } }));
        return;
      }
      const columns = await window.sqlStudio['schema:columns']({
        connectionId,
        database: db,
        table: t.table,
      });
      if (seq !== requestSeq.current) return;
      setCaches((c) => ({ ...c, [key]: { key, ref: t, columns, loading: false } }));
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setCaches((c) => ({
        ...c,
        [key]: { key, ref: t, columns: [], loading: false, error: err instanceof Error ? err.message : '加载字段失败' },
      }));
    }
  };

  // 选中变化 → 拉字段；初次对全部表也预取第一张
  useEffect(() => {
    if (!selectedKey) return;
    const t = tables.find((x) => keyOf(x) === selectedKey);
    if (t) void loadColumns(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, tables, connectionId, database]);

  if (!open) {
    return (
      <div className="table-fields-panel collapsed">
        <button className="table-fields-toggle" onClick={onToggle} title="展开表字段导航">
          <Columns3 size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="table-fields-panel"
      style={width !== null ? { width } : undefined}
    >
      {/* 左边界宽度拖拽手柄（可拖拽宽度） */}
      <div
        className="table-fields-width-handle"
        data-testid="table-fields-width-handle"
        title="拖拽调整导航栏宽度"
        onPointerDown={onWidthStart}
        onPointerMove={onWidthMove}
        onPointerUp={onWidthEnd}
      />
      <div className="table-fields-head">
        <span className="table-fields-title"><Columns3 size={13} /> 表字段</span>
        {onToggle && (
          <button className="table-fields-close" onClick={onToggle} title="折叠">
            <X size={13} />
          </button>
        )}
      </div>

      {tables.length === 0 ? (
        <div className="table-fields-empty">
          在编辑器中输入含 FROM/JOIN 的 SQL 后，这里会显示引用的表
        </div>
      ) : (
        <>
          {/* 表切换（横向滚动） */}
          <div className="table-fields-tabs">
            {tables.map((t) => {
              const key = keyOf(t);
              const c = caches[key];
              return (
                <button
                  key={key}
                  className={`table-fields-tab${selectedKey === key ? ' active' : ''}`}
                  title={`${t.db ? t.db + '.' : ''}${t.table}`}
                  onClick={() => setSelectedKey(key)}
                >
                  <Table2 size={12} />
                  <span className="table-fields-tab-name">{t.table}</span>
                  {t.db && <em className="table-fields-tab-db">{t.db}</em>}
                  {c?.loading && <Loader2 size={11} className="spin" />}
                </button>
              );
            })}
          </div>

          {/* 字段列表 */}
          <div className="table-fields-body">
            {tables.map((t) => {
              if (keyOf(t) !== selectedKey) return null;
              const c = caches[keyOf(t)];
              if (!c) return null;
              if (c.loading) return <div key={keyOf(t)} className="table-fields-loading"><Loader2 size={14} className="spin" /> 加载字段…</div>;
              if (c.error) return <div key={keyOf(t)} className="table-fields-error">{c.error}</div>;
              if (!c.columns.length) return <div key={keyOf(t)} className="table-fields-empty">该表无字段或无法读取</div>;
              return (
                <ul key={keyOf(t)} className="table-fields-cols">
                  {c.columns.map((col) => (
                    <li
                      key={col.name}
                      className={`table-fields-col${col.isPrimary ? ' pk' : ''}`}
                      title={`${col.type}${col.comment ? ' · ' + col.comment : ''}`}
                      onClick={() => onInsertField(col.name)}
                    >
                      <MousePointerClick size={11} className="table-fields-col-icon" />
                      <span className="table-fields-col-name">{col.name}</span>
                      {col.comment ? (
                        <span className="table-fields-col-comment">{col.comment}</span>
                      ) : (
                        <span className="table-fields-col-type">{col.type}</span>
                      )}
                    </li>
                  ))}
                </ul>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
