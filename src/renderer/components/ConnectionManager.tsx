/**
 * 连接管理面板（任务 8 ui-connection，体验优化 §14 增强，UI 重设计 S3）。
 * 加载连接列表、新增/保存/编辑/删除、选中连接并回调 onSelect。
 * 通过 window.sqlStudio 调用主进程；连接摘要不含密码（铁律 R6）。
 *
 * UI 重设计（实施规范 §5.3）：
 *  - 连接项两行布局：第一行名称 + 状态，第二行 host/port/db 摘要。
 *  - 新建连接按钮用图标 + tooltip。
 *  - 编辑 / 测试 / 删除放入右侧更多菜单（不依赖 hover 才发现关键操作）。
 *  - 编辑连接复用 ConnectionForm（connectionId + initial），保存走 connections:save（含 id）。
 */
import { useEffect, useState } from 'react';
import { Plus, MoreHorizontal, Pencil, Plug, Trash2, Server } from 'lucide-react';
import type { ConnectionInput, ConnectionSummary } from '@shared/types';
import { ConnectionForm } from './ConnectionForm';

/** 连接状态（顶部应用栏/状态栏展示用）。unknown = 尚未测试。 */
export type ConnStatus = 'testing' | 'ok' | 'error' | 'unknown';

export interface ConnectionManagerProps {
  onSelect: (id: string | null) => void;
  selectedId?: string;
  /** 连接列表/状态变化时上报（App 用于顶部应用栏与底部状态栏展示，可选）。 */
  onConnectionsChange?: (connections: ConnectionSummary[], statuses: Record<string, ConnStatus>) => void;
}

export function ConnectionManager({ onSelect, selectedId, onConnectionsChange }: ConnectionManagerProps) {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  /** 编辑中的连接（id + 摘要，用于表单回填）。 */
  const [editing, setEditing] = useState<ConnectionSummary | null>(null);
  /** 更多菜单打开于哪个连接 id。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connStatuses, setConnStatuses] = useState<Record<string, ConnStatus>>({});

  // 连接列表/状态变化时上报父组件（顶部应用栏与底部状态栏数据源）
  useEffect(() => {
    onConnectionsChange?.(connections, connStatuses);
  }, [connections, connStatuses, onConnectionsChange]);

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

  const handleSave = async (input: ConnectionInput & { id?: string }) => {
    try {
      const saved = await window.sqlStudio['connections:save'](input);
      setShowForm(false);
      setEditing(null);
      await refresh();
      if (saved?.id) void testConnection(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存连接失败');
    }
  };

  const handleTest = async (input: ConnectionInput) => {
    const res = await window.sqlStudio['connections:test'](input);
    if (!res.ok) throw new Error(res.message);
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm('确定删除此连接？')) return;
    try {
      await window.sqlStudio['connections:remove']({ id });
      setMenuFor(null);
      onSelect(null); // 清除选中状态
      await refresh();
    } catch (err) {
      window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 打开编辑表单：用连接摘要回填（不含密码，密码留空 = 保留旧密码）。 */
  const handleEdit = async (c: ConnectionSummary) => {
    setMenuFor(null);
    setShowForm(false);
    setEditing(c);
  };

  if (loading) {
    return (
      <div className="conn-manager conn-manager-loading">
        <span className="conn-loading-spinner" aria-hidden="true" />
        <span>加载连接…</span>
      </div>
    );
  }

  return (
    <div className="conn-manager">
      <div className="conn-header">
        <h3>连接</h3>
        <button
          className="conn-add-btn"
          onClick={() => {
            setShowForm((v) => !v);
            setEditing(null);
          }}
          title="新建连接"
        >
          <Plus size={14} />
          <span>{showForm ? '取消' : '新建'}</span>
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {(showForm || editing) && (
        <div className="conn-form-wrap">
          <ConnectionForm
            connectionId={editing?.id}
            initial={editing ? {
              name: editing.name,
              host: editing.host,
              port: editing.port,
              user: editing.user,
              database: editing.database,
              charset: editing.charset,
            } : undefined}
            onSave={handleSave}
            onTest={handleTest}
            onCancel={() => { setShowForm(false); setEditing(null); }}
          />
        </div>
      )}
      <ul className="conn-list">
        {connections.map((c) => {
          const status = connStatuses[c.id];
          return (
            <li
              key={c.id}
              className={c.id === selectedId ? 'selected' : ''}
              onClick={() => onSelect(c.id)}
            >
              <div className="conn-row">
                <Server size={15} className="conn-row-icon" />
                <div className="conn-row-main">
                  <div className="conn-row-line1">
                    <span className={`conn-status conn-status-${status ?? 'unknown'}`} title={
                      status === 'testing' ? '测试中…'
                      : status === 'ok' ? '连接正常'
                      : status === 'error' ? '连接失败'
                      : '未测试'
                    } />
                    <span className="conn-name">{c.name}</span>
                  </div>
                  <div className="conn-row-line2">
                    {c.user}@{c.host}:{c.port}
                    {c.database ? `/${c.database}` : ''}
                  </div>
                </div>
                <button
                  className="conn-more-btn"
                  title="更多操作"
                  aria-label={`更多操作：${c.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(menuFor === c.id ? null : c.id);
                  }}
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
              {menuFor === c.id && (
                <>
                  {/* 透明遮罩：点击外部关闭更多菜单 */}
                  <div
                    className="conn-menu-backdrop"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(null);
                    }}
                  />
                  <div className="conn-menu">
                    <button
                      className="conn-menu-item"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                        void handleEdit(c);
                      }}
                    >
                      <Pencil size={13} /> 编辑
                    </button>
                    <button
                      className="conn-menu-item"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                        void testConnection(c.id);
                      }}
                    >
                      <Plug size={13} /> 测试连接
                    </button>
                    <button
                      className="conn-menu-item danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                        void handleRemove(c.id);
                      }}
                    >
                      <Trash2 size={13} /> 删除
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
