/**
 * 连接管理面板（任务 8 ui-connection）。
 * 加载连接列表、新增/保存/删除、选中连接并回调 onSelect。
 * 通过 window.sqlStudio 调用主进程；连接摘要不含密码（铁律 R6）。
 */
import { useEffect, useState } from 'react';
import type { ConnectionSummary } from '@shared/types';
import { ConnectionForm } from './ConnectionForm';

export interface ConnectionManagerProps {
  onSelect: (id: string) => void;
  selectedId?: string;
}

export function ConnectionManager({ onSelect, selectedId }: ConnectionManagerProps) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await window.sqlStudio['connections:list']();
      setConnections(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载连接失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleSave = async (input: Parameters<typeof window.sqlStudio['connections:save']>[0]) => {
    await window.sqlStudio['connections:save'](input);
    setShowForm(false);
    await refresh();
  };

  const handleTest = async (input: Parameters<typeof window.sqlStudio['connections:test']>[0]) => {
    await window.sqlStudio['connections:test'](input);
  };

  const handleRemove = async (id: string) => {
    await window.sqlStudio['connections:remove']({ id });
    await refresh();
  };

  if (loading) return <div className="conn-manager">加载中…</div>;

  return (
    <div className="conn-manager">
      <div className="conn-header">
        <h3>连接</h3>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? '取消' : '新建连接'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {showForm && <ConnectionForm onSave={handleSave} onTest={handleTest} />}
      <ul className="conn-list">
        {connections.map((c) => (
          <li
            key={c.id}
            className={c.id === selectedId ? 'selected' : ''}
            onClick={() => onSelect(c.id)}
          >
            <span className="conn-name">{c.name}</span>
            <span className="conn-meta">
              {c.user}@{c.host}:{c.port}
              {c.database ? `/${c.database}` : ''}
            </span>
            <button
              className="del"
              onClick={(e) => {
                e.stopPropagation();
                void handleRemove(c.id);
              }}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
