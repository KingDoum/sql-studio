/**
 * ResultTabs（任务 10 ui-results）。
 * 从 workspace.execution 读取最近一次执行：
 *   - 无执行 → 空提示；有错误 → 错误面板；有结果 → 多结果集标签 + ResultGrid。
 *   - 状态栏：总耗时 / 行数合计 / 截断提示 / 写语句提示。
 */
import { useState } from 'react';
import { useWorkspace } from '@renderer/store/workspace';
import { ResultGrid } from './ResultGrid';

export function ResultTabs() {
  const execution = useWorkspace((s) => s.execution);
  const [activeSet, setActiveSet] = useState(0);

  if (!execution) {
    return (
      <div className="result-panel">
        <div className="result-empty">
          暂无查询结果 —— 在编辑器中按 Ctrl+Enter（或点「▶ 执行」）执行 SQL
        </div>
      </div>
    );
  }

  if (execution.error) {
    return (
      <div className="result-panel">
        <div className="result-error">
          <div className="result-error-title">⚠ 执行失败</div>
          <pre className="result-error-msg">{execution.error}</pre>
          <div className="result-error-sql">{execution.sql}</div>
        </div>
      </div>
    );
  }

  const result = execution.result;
  if (!result) return null;

  const totalRows = result.resultSets.reduce((n, s) => n + s.rows.length, 0);
  const safeSet = Math.min(activeSet, result.resultSets.length - 1);

  return (
    <div className="result-panel">
      {result.resultSets.length > 1 && (
        <div className="result-tabs">
          {result.resultSets.map((rs, i) => (
            <button
              key={rs.index}
              className={`result-tab${i === safeSet ? ' active' : ''}`}
              onClick={() => setActiveSet(i)}
            >
              结果 {i + 1}
              {rs.truncated ? ' ⚠' : ''}
              <span className="result-tab-meta">{rs.rows.length} 行</span>
            </button>
          ))}
        </div>
      )}
      <div className="result-grid-host">
        <ResultGrid columns={result.resultSets[safeSet].columns} rows={result.resultSets[safeSet].rows} />
      </div>
      <div className="result-status">
        <span>耗时 {result.totalElapsedMs} ms</span>
        <span>共 {result.resultSets.length} 个结果集</span>
        <span>合计 {totalRows} 行</span>
        {result.truncated && (
          <span className="status-warn">⚠ 结果超出上限已截断（仅显示前 5 万行）</span>
        )}
        {result.hasWrite && <span className="status-warn">⚠ 包含写操作</span>}
      </div>
    </div>
  );
}