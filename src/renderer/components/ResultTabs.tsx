/**
 * ResultTabs（任务 10 ui-results，UI 重设计 S3 增强）。
 * 从 workspace.execution 读取最近一次执行：
 *   - 无执行 → 空提示；有错误 → 错误面板；有结果 → 多结果集标签 + ResultGrid。
 *   - 结果工具栏：结果集标签 / 行数 / 耗时 / 导出（ExportMenu）/ 筛选开关，分层展示。
 *   - 结果区高度可拖拽（上边界手柄），最小高度固定。
 *
 * UI 重设计（实施规范 §4.6 / §5.7）：
 *  - 导出动作放在结果工具栏，不占用每行空间。
 *  - 筛选入口在工具栏（开关筛选行），表头/筛选/表体仍共用同一列宽源（ResultGrid 内部）。
 *  - 空结果、加载、错误、截断和成功状态分别设计。
 */
import { useRef, useState } from 'react';
import { Filter, FilterX, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '@renderer/store/workspace';
import { ResultGrid } from './ResultGrid';
import { ExportMenu } from './ExportMenu';

const MIN_PANEL_H = 120;
const MAX_PANEL_H_RATIO = 0.8;

export function ResultTabs() {
  const execution = useWorkspace((s) => s.execution);
  const [activeSet, setActiveSet] = useState(0);
  /** 筛选行开关（默认展开）。 */
  const [showFilter, setShowFilter] = useState(true);
  /** 结果区高度（null = 使用默认 CSS 高度）。 */
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = panelRef.current;
    if (!el) return;
    dragRef.current = { startY: e.clientY, startH: el.offsetHeight };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const maxH = Math.round(window.innerHeight * MAX_PANEL_H_RATIO);
    const h = Math.min(Math.max(d.startH + (d.startY - e.clientY), MIN_PANEL_H), maxH);
    setPanelHeight(h);
  };

  const onResizeEnd = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      className="result-panel"
      ref={panelRef}
      style={panelHeight !== null ? { height: panelHeight } : undefined}
    >
      {/* 上边界拖拽条 */}
      <div
        className="result-resize-handle"
        data-testid="result-resize-handle"
        title="拖拽调整结果区高度"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      />

      {!execution && (
        <div className="result-empty">
          暂无查询结果 —— 在编辑器中按 Ctrl+Enter（或点「执行」）执行 SQL
        </div>
      )}

      {execution?.error && (
        <div className="result-error">
          <div className="result-error-title">执行失败</div>
          <pre className="result-error-msg">{execution.error}</pre>
          <div className="result-error-sql">{execution.sql}</div>
        </div>
      )}

      {execution?.result && (
        <>
          <div className="result-toolbar">
            {execution.result.resultSets.length > 1 ? (
              <div className="result-tabs">
                {execution.result.resultSets.map((rs, i) => (
                  <button
                    key={rs.index}
                    className={`result-tab${i === activeSet ? ' active' : ''}`}
                    onClick={() => setActiveSet(i)}
                  >
                    结果 {i + 1}
                    {rs.truncated ? <AlertTriangle size={11} /> : ''}
                    <span className="result-tab-meta">{rs.rows.length} 行</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="result-tabs">
                <button className="result-tab active">结果 1</button>
              </div>
            )}
            <div className="result-toolbar-actions">
              <button
                className={`result-toolbar-btn${showFilter ? ' active' : ''}`}
                title={showFilter ? '隐藏筛选行' : '显示筛选行'}
                onClick={() => setShowFilter((v) => !v)}
              >
                {showFilter ? <FilterX size={13} /> : <Filter size={13} />}
                <span>筛选</span>
              </button>
              <ExportMenu />
            </div>
          </div>
          <div className="result-grid-host">
            <ResultGrid
              columns={execution.result.resultSets[activeSet]?.columns ?? []}
              rows={execution.result.resultSets[activeSet]?.rows ?? []}
              showFilter={showFilter}
            />
          </div>
          <div className="result-status">
            <span>耗时 {execution.result.totalElapsedMs} ms</span>
            <span>共 {execution.result.resultSets.length} 个结果集</span>
            <span>合计{' '}
              {execution.result.resultSets.reduce((n, rs) => n + rs.rows.length, 0)} 行
            </span>
            {execution.result.truncated && (
              <span className="status-warn"><AlertTriangle size={11} /> 结果超出上限已截断（仅显示前 5 万行）</span>
            )}
            {execution.result.hasWrite && <span className="status-warn"><AlertTriangle size={11} /> 包含写操作</span>}
          </div>
        </>
      )}
    </div>
  );
}
