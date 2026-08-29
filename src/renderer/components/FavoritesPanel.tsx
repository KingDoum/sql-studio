/**
 * FavoritesPanel（任务 11 ui-export-history，会话8d 增强，UI 重设计 S4 统一弹窗）。
 * 命名收藏弹窗：从 `userData/queries/` 读取 .sql 文件列表，
 * 展示文件名/标签/连接/时间，点击打开进编辑器，删除 + 重命名 + 搜索过滤。
 *
 * 数据来源：favorites:list / favorites:open / favorites:remove / favorites:rename IPC。
 * 打开编辑器的动作通过 onOpenFavorite(filePath) 回调上行。
 */
import { useEffect, useState } from 'react';
import { Pencil, Check, XCircle, Trash2 } from 'lucide-react';
import type { FavoriteItem } from '@shared/types';
import { Modal } from './Modal';

export interface FavoritesPanelProps {
  open: boolean;
  onClose(): void;
  onOpen(name: string): void;
}

export function FavoritesPanel({ open, onClose, onOpen }: FavoritesPanelProps) {
  const [items, setItems] = useState<FavoriteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  /** 正在重命名的收藏（原名）与输入值。 */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    window.sqlStudio['favorites:list']()
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载收藏失败'))
      .finally(() => setLoading(false));
  }, [open]);

  const kw = keyword.trim().toLowerCase();
  const visible = kw
    ? items.filter(
        (f) =>
          f.name.toLowerCase().includes(kw) ||
          (f.tags ?? []).some((t) => t.toLowerCase().includes(kw)),
      )
    : items;

  const startRename = (fav: FavoriteItem) => {
    setRenaming(fav.name);
    setRenameValue(fav.name);
  };

  const confirmRename = async (oldName: string) => {
    const newName = renameValue.trim();
    if (!newName || newName === oldName) {
      setRenaming(null);
      return;
    }
    try {
      await window.sqlStudio['favorites:rename']({ name: oldName, newName });
      // 刷新列表（后端已更新）
      const list = await window.sqlStudio['favorites:list']();
      setItems(list);
    } catch (err) {
      window.alert(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRenaming(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="命名收藏" width={620}>
      <div className="history-toolbar">
        <input
          className="history-search"
          placeholder="搜索收藏名 / 标签…"
          aria-label="搜索收藏"
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
        <div className="modal-empty">暂无收藏（可在历史中另存为收藏）</div>
      )}
      {!loading && !error && items.length > 0 && visible.length === 0 && (
        <div className="modal-empty">未找到匹配「{keyword}」的收藏</div>
      )}
      <ul className="favorites-list">
        {visible.map((fav) => (
          <li key={fav.filePath} className="favorite-item">
            <div className="favorite-item-main" onClick={() => onOpen(fav.name)}>
              {renaming === fav.name ? (
                <div className="rename-row" onClick={(e) => e.stopPropagation()}>
                  <input
                    className="rename-input"
                    value={renameValue}
                    autoFocus
                    aria-label="重命名收藏"
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirmRename(fav.name);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                  <button className="rename-btn ok" title="确认" onClick={() => void confirmRename(fav.name)}>
                    <Check size={13} />
                  </button>
                  <button className="rename-btn" title="取消" onClick={() => setRenaming(null)}>
                    <XCircle size={13} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="favorite-name">{fav.name}</div>
                  <div className="favorite-meta">
                    {fav.tags?.length ? fav.tags.map((t) => <span key={t} className="favorite-tag">{t}</span>) : null}
                    {fav.connectionId && <span className="favorite-conn">{fav.connectionId}</span>}
                    <span className="favorite-time">{new Date(fav.createdAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </>
              )}
            </div>
            <div className="favorite-actions">
              <button className="favorite-act" title="重命名" onClick={() => startRename(fav)}>
                <Pencil size={12} />
              </button>
              <button
                className="favorite-act del"
                title="删除"
                onClick={async () => {
                  if (!window.confirm(`确定删除收藏「${fav.name}」？`)) return;
                  try {
                    await window.sqlStudio['favorites:remove']({ name: fav.name });
                    setItems((prev) => prev.filter((f) => f.name !== fav.name));
                  } catch { /* 静默 */ }
                }}
              >
                <Trash2 size={13} /> 删除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
