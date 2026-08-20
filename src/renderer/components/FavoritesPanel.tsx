/**
 * FavoritesPanel（任务 11 ui-export-history）。
 * 命名收藏弹窗：从 `userData/queries/` 读取 .sql 文件列表，
 * 展示文件名/标签/连接/时间，点击打开进编辑器，删除。
 *
 * 数据来源：favorites:list / favorites:open / favorites:remove IPC。
 * 打开编辑器的动作通过 onOpenFavorite(filePath) 回调上行。
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { FavoriteItem } from '@shared/types';

export interface FavoritesPanelProps {
  open: boolean;
  onClose(): void;
  onOpen(name: string): void;
}

export function FavoritesPanel({ open, onClose, onOpen }: FavoritesPanelProps) {
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    window.sqlStudio['favorites:list']()
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载收藏失败'))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>命名收藏</h3>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          {loading && <div className="modal-loading">加载中…</div>}
          {error && <div className="modal-error">{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div className="modal-empty">暂无收藏（可在历史中另存为收藏）</div>
          )}
          <ul className="favorites-list">
            {items.map((fav) => (
              <li key={fav.filePath} className="favorite-item">
                <div className="favorite-item-main" onClick={() => onOpen(fav.name)}>
                  <div className="favorite-name">{fav.name}</div>
                  <div className="favorite-meta">
                    {fav.tags?.length ? fav.tags.map((t) => <span key={t} className="favorite-tag">{t}</span>) : null}
                    {fav.connectionId && <span className="favorite-conn">{fav.connectionId}</span>}
                    <span className="favorite-time">{new Date(fav.createdAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
                <button
                  className="favorite-del"
                  title="删除"
                  onClick={async () => {
                    try {
                      await window.sqlStudio['favorites:remove']({ name: fav.name });
                      setItems((prev) => prev.filter((f) => f.name !== fav.name));
                    } catch { /* 静默 */ }
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}