/**
 * HistoryPanel（任务 11 ui-export-history）。
 * 执行历史弹窗：列表展示（SQL 摘要/时间/连接/耗时）、
 * 点击回填编辑器、删除、一键另存为命名 .sql 收藏。
 *
 * 数据来源：history:list IPC（SQLite 历史，由 query-service 自动记录）。
 * 打开编辑器的动作通过 onOpenEditor(sql) 回调上行。
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { HistoryItem } from '@shared/types';

export interface HistoryPanelProps {
  open: boolean;
  onClose(): void;
  onBackfillSql(sql: string): void;
  onSaveAsFavorite(sql: string): void;
}

export function HistoryPanel({ open, onClose, onBackfillSql, onSaveAsFavorite }: HistoryPanelProps) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    window.sqlStudio['history:list']({ limit: 200 })
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载历史失败'))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  // 本地搜索过滤（不重新请求 IPC）
  const kw = keyword.trim().toLowerCase();
  const visible = kw
    ? items.filter(
        (h) =>
          h.sql.toLowerCase().includes(kw) ||
          (h.connectionName ?? '').toLowerCase().includes(kw),
      )
    : items;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>执行历史</h3>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="history-toolbar">
            <input
              className="history-search"
              placeholder="搜索 SQL / 连接名…"
              value={keyword}
              autoFocus
              onChange={(e) => setKeyword(e.target.value)}
            />
            <span className="history-count">
              {visible.length} / {items.length} 条
            </span>
          </div>
          {loading && <div className="modal-loading">加载中…</div>}
          {error && <div className="modal-error">{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div className="modal-empty">暂无执行历史</div>
          )}
          {!loading && !error && items.length > 0 && visible.length === 0 && (
            <div className="modal-empty">未找到匹配「{keyword}」的历史记录</div>
          )}
          <ul className="history-list">
            {visible.map((h) => (
              <li key={h.id} className="history-item">
                <div className="history-item-main">
                  <div className="history-sql" onClick={() => onBackfillSql(h.sql)} title="点击回填编辑器">
                    <code>{h.sql}</code>
                  </div>
                  <div className="history-meta">
                    <span>{h.connectionName && `${h.connectionName} · `}{h.elapsedMs}ms · {h.rowCount} 行</span>
                    <span className="history-time">
                      {new Date(h.executedAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
                <div className="history-actions">
                  <button
                    className="history-action"
                    title="另存为收藏"
                    onClick={() => onSaveAsFavorite(h.sql)}
                  >
                    收藏
                  </button>
                  <button
                    className="history-action del"
                    title="删除"
                    onClick={async () => {
                      try {
                        await window.sqlStudio['history:remove']({ id: h.id });
                        setItems((prev) => prev.filter((x) => x.id !== h.id));
                      } catch { /* 静默 */ }
                    }}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}