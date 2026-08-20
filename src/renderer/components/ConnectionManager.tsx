/**
 * 连接管理面板（任务 8 ui-connection，体验优化 §14 增强）。
 * 加载连接列表、新增/保存/删除、选中连接并回调 onSelect。
 * 通过 window.sqlStudio 调用主进程；连接摘要不含密码（铁律 R6）。
 *
 * 体验优化（2026-08-20 会话8）：
 *  - 连接状态指示：保存后自动测试连接，显示绿/灰/红圆点。
 *  - 测试通过 `connections:testById`（主进程解密配置，渲染零直连）。
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
  const [connStatuses, setConnStatuses] = useState<Record<string, 'testing' | 'ok' | 'error'>>({});

  const refresh = async () => {
    try {
      const list = await window.sqlStudio['connections:list']();
      setConnections(list);
      // 自动测试每个连接（异步，不阻塞 UI）
      for (const c of list) {
        testConnection(c.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载连接失败');
    } finally {
      setLoading(false);
    }
  };

  const testConnection = async (id: string) => {
    setConnStatuses((s) => ({ ...s, [id]: 'testing' }));
    try {
      const res = await window.sqlStudio['connections:testById']({ id });
      setConnStatuses((s) => ({ ...s, [id]: res.ok ? 'ok' : 'error' }));
    } catch {
      setConnStatuses((s) => ({ ...s, [id]: 'error' }));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleSave = async (input: Parameters<typeof window.sqlStudio['connections:save']>[0]) => {
    try {
      const saved = await window.sqlStudio['connections:save'](input);
      setShowForm(false);
      await refresh();
      if (saved?.id) void testConnection(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存连接失败');
    }
  };

  const handleTest = async (input: Parameters<typeof window.sqlStudio['connections:test']>[0]) => {
    const res = await window.sqlStudio['connections:test'](input);
    if (!res.ok) throw new Error(res.message);
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
        {connections.map((c) => {
          const status = connStatuses[c.id];
          return (
            <li
              key={c.id}
              className={c.id === selectedId ? 'selected' : ''}
              onClick={() => onSelect(c.id)}
            >
              <span className={`conn-status conn-status-${status ?? 'unknown'}`} title={
                status === 'testing' ? '测试中…'
                : status === 'ok' ? '连接正常'
                : status === 'error' ? '连接失败'
                : '未测试'
              } />
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
          );
        })}
      </ul>
    </div>
  );
}