/**
 * ResultGrid（任务 10 ui-results，体验优化 §14 增强）。
 * 大数据结果表格：固定行高虚拟滚动、表头点击排序、按列筛选、双击复制。
 *
 * 体验优化（2026-08-20）：
 *  - 列宽可拖拽：表头右侧 resize handle（pointer events + setPointerCapture）。
 *  - 表头 / 筛选行 / 表体共用同一个 `gridTemplateColumns`（单一列宽源），
 *    根治「筛选行与表头错位」问题（对齐 Beekeeper/tabulator 的单一 column 驱动思路）。
 *
 * 布局：
 *   ┌──────────────┐   ← 表头（固定，grid 列宽 = 单一源）
 *   ├──────────────┤   ← 筛选行（固定，同一 gridTemplateColumns）
 *   ├──────────────┤   ← 数据体（overflow-y:auto，虚拟滚动，同列宽）
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
const DEFAULT_COL_W = 150;
const MIN_COL_W = 60;
const MAX_COL_W = 600;

export function ResultGrid({ columns, rows }: ResultGridProps) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('none');
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(200);
  const [toast, setToast] = useState<string | null>(null);
  /** 列宽（单一来源：表头/筛选/表体共用）。下标 → 像素宽。 */
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 拖拽状态：列下标 + 起始 X + 起始宽。 */
  const dragRef = useRef<{ ci: number; startX: number; startW: number } | null>(null);

  const getWidth = (ci: number) => colWidths[ci] ?? DEFAULT_COL_W;
  const gridTemplate = useMemo(
    () => columns.map((_, ci) => `${getWidth(ci)}px`).join(' '),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, colWidths],
  );
  const minWidth = useMemo(
    () => columns.reduce((s, _, ci) => s + getWidth(ci), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, colWidths],
  );

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

  // ── 列宽拖拽 ──
  const onResizeStart = (ci: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // jsdom 无 setPointerCapture，可选调用保证测试/兼容
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { ci, startX: e.clientX, startW: getWidth(ci) };
  };

  const onResizeMove = (ci: number) => (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.ci !== ci) return;
    const delta = e.clientX - drag.startX;
    const w = Math.min(Math.max(drag.startW + delta, MIN_COL_W), MAX_COL_W);
    setColWidths((cw) => ({ ...cw, [ci]: w }));
  };

  const onResizeEnd = (ci: number) => (e: React.PointerEvent) => {
    if (dragRef.current?.ci !== ci) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
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
      {/* 表头（固定，grid 列宽单一源） */}
      <div className="grid-header" style={{ gridTemplateColumns: gridTemplate, minWidth }}>
        {columns.map((c, ci) => (
          <div
            key={c.name}
            className={`grid-header-cell${sortCol === ci && sortDir !== 'none' ? ' sorting' : ''}`}
            onClick={() => handleSortClick(ci)}
            title={c.comment || c.type}
          >
            <span className="grid-col-name">{c.name}</span>
            <span className="grid-col-meta">{c.type}</span>
            {sortCol === ci && sortDir !== 'none' && (
              <span className="grid-sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>
            )}
            <span
              className="grid-resize-handle"
              data-testid={`resize-${c.name}`}
              onPointerDown={onResizeStart(ci)}
              onPointerMove={onResizeMove(ci)}
              onPointerUp={onResizeEnd(ci)}
            />
          </div>
        ))}
      </div>
      {/* 筛选行（固定，同一 gridTemplateColumns） */}
      <div className="grid-filter" style={{ gridTemplateColumns: gridTemplate, minWidth }}>
        {columns.map((c, ci) => (
          <input
            key={`f-${c.name}`}
            className="grid-filter-input"
            placeholder="筛选…"
            value={filters[ci] ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, [ci]: e.target.value }))}
          />
        ))}
      </div>
      {/* 数据体（虚拟滚动，同列宽） */}
      <div className="grid-body" ref={handleBodyRef} onScroll={handleBodyScroll} style={{ minWidth }}>
        <div className="grid-spacer" style={{ height: visibleRows.length * ROW_HEIGHT, minWidth }}>
          {rendered.map((row, ri) => {
            const absIdx = start + ri;
            return (
              <div
                key={absIdx}
                className="grid-row"
                style={{ top: absIdx * ROW_HEIGHT, gridTemplateColumns: gridTemplate, minWidth }}
              >
                {row.map((cell, ci) => {
                  const isNull = cell === null || cell === undefined;
                  const text = formatCell(cell);
                  return (
                    <div
                      key={`${absIdx}-${ci}`}
                      className={`grid-cell${isNull ? ' null-cell' : ''}`}
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