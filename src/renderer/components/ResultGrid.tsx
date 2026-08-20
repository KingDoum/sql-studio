/**
 * ResultGrid（任务 10 ui-results）。
 * 大数据结果表格：固定行高虚拟滚动、表头点击排序、按列筛选、双击复制。
 *
 * 布局：
 *   ┌──────────────┐   ← 表头（固定）
 *   ├──────────────┤   ← 筛选行（固定）
 *   ├──────────────┤   ← 数据体（overflow-y:auto，虚拟滚动）
 *   ├──────────────┤   ← toast 覆盖层
 *   └──────────────┘   ← 状态栏（行数/排序提示）
 */
import { useMemo, useRef, useState, useCallback } from 'react';
import type { CellValue, ColumnMeta } from '@shared/types';
import { compareCell, formatCell, matchesFilter } from '@renderer/lib/cell-format';

export interface ResultGridProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
}

type SortDir = 'asc' | 'desc' | 'none';

const ROW_HEIGHT = 24;
const OVERSCAN = 10;
const COL_W = 150;

export function ResultGrid({ columns, rows }: ResultGridProps) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('none');
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(200);
  const [toast, setToast] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minWidth = columns.length * COL_W;

  // 排序 + 筛选（内存完成）
  const visibleRows = useMemo(() => {
    let out = rows;
    const activeFilters = Object.entries(filters).filter(([, kw]) => kw.trim() !== '');
    if (activeFilters.length) {
      out = out.filter((row) =>
        activeFilters.every(([ci, kw]) => matchesFilter(row[Number(ci)], kw)),
      );
    }
    if (sortCol !== null && sortDir !== 'none') {
      out = [...out].sort((ra, rb) => {
        const cmp = compareCell(ra[sortCol], rb[sortCol]);
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, filters, sortCol, sortDir]);

  // 可视区间
  const { start, end } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
    return { start: first, end: Math.min(visibleRows.length, first + count) };
  }, [scrollTop, viewportH, visibleRows.length]);

  const rendered = useMemo(() => visibleRows.slice(start, end), [visibleRows, start, end]);

  const handleBodyScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    if (!viewportH) setViewportH(e.currentTarget.clientHeight || 200);
  }, [viewportH]);

  const handleBodyRef = useCallback((el: HTMLDivElement | null) => {
    bodyRef.current = el;
    if (el) setViewportH(el.clientHeight || 200);
  }, []);

  const handleSortClick = (ci: number) => {
    if (sortCol !== ci) {
      setSortCol(ci);
      setSortDir('asc');
    } else {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'none'));
    }
  };

  const copyCell = async (value: CellValue | undefined) => {
    const text = formatCell(value);
    try {
      await navigator.clipboard.writeText(text);
      showToast(`已复制：${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
    } catch {
      showToast('复制失败');
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1600);
  };

  if (!columns.length || !rows.length) {
    return <div className="grid-empty">（空结果集）</div>;
  }

  return (
    <div className="result-grid-wrap">
      {/* 表头（固定） */}
      <div className="grid-header" style={{ minWidth }}>
        {columns.map((c, ci) => (
          <div
            key={c.name}
            className={`grid-header-cell${sortCol === ci && sortDir !== 'none' ? ' sorting' : ''}`}
            style={{ width: COL_W }}
            onClick={() => handleSortClick(ci)}
            title={c.comment || c.type}
          >
            <span className="grid-col-name">{c.name}</span>
            <span className="grid-col-meta">{c.type}</span>
            {sortCol === ci && sortDir !== 'none' && (
              <span className="grid-sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>
            )}
          </div>
        ))}
      </div>
      {/* 筛选行（固定） */}
      <div className="grid-filter" style={{ minWidth }}>
        {columns.map((c, ci) => (
          <input
            key={`f-${c.name}`}
            className="grid-filter-input"
            style={{ width: COL_W - 16 }}
            placeholder="筛选…"
            value={filters[ci] ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, [ci]: e.target.value }))}
          />
        ))}
      </div>
      {/* 数据体（虚拟滚动） */}
      <div className="grid-body" ref={handleBodyRef} onScroll={handleBodyScroll} style={{ minWidth }}>
        <div className="grid-spacer" style={{ height: visibleRows.length * ROW_HEIGHT, minWidth }}>
          {rendered.map((row, ri) => {
            const absIdx = start + ri;
            return (
              <div
                key={absIdx}
                className="grid-row"
                style={{ top: absIdx * ROW_HEIGHT, minWidth }}
              >
                {row.map((cell, ci) => {
                  const isNull = cell === null || cell === undefined;
                  const text = formatCell(cell);
                  return (
                    <div
                      key={`${absIdx}-${ci}`}
                      className={`grid-cell${isNull ? ' null-cell' : ''}`}
                      style={{ width: COL_W }}
                      title={text.length > 120 ? text : undefined}
                      onDoubleClick={() => void copyCell(cell)}
                    >
                      {isNull ? 'NULL' : text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {toast && <div className="grid-toast">{toast}</div>}
      <div className="grid-footer">
        {visibleRows.length !== rows.length && `${rows.length - visibleRows.length} 行被筛选隐藏 · `}
        显示 {visibleRows.length} 行
        {sortDir !== 'none' && sortCol !== null && ` · 按 ${columns[sortCol].name} ${sortDir === 'asc' ? '↑' : '↓'}`}
      </div>
    </div>
  );
}