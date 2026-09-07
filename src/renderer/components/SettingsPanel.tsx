/**
 * SettingsPanel（设置面板：调试模式 + 持久日志，自动保存方案 §14.1）
 *
 * 日志数据源（S4 起）：
 * - 通过 `logs:read` 读取 Main 持久日志最近 500 条（跨重启、覆盖 Renderer 崩溃）；
 * - 清空通过 `logs:clear`（Main 只清受控日志，§12.10）；
 * - 复制基于 Main 返回并脱敏的数据（北京时间，§12.9/§12.10）。
 *
 * debugMode 产品开关语义保留：关闭时普通 log/info 不采集（bridge 控制），
 * 但本面板仍可读取 Main 自启动起的生命周期日志。
 */
import { useEffect, useState, useCallback } from 'react';
import { Bug, Copy, Check, Trash2 } from 'lucide-react';
import { formatBeijingTime, formatPersistentLogLine } from '@renderer/lib/debug-log';
import { Modal } from './Modal';
import type { PersistentLogEntry } from '@shared/types';

export interface SettingsPanelProps {
  open: boolean;
  debugMode: boolean;
  onDebugModeChange(enabled: boolean): void;
  onClose(): void;
}

export function SettingsPanel({
  open,
  debugMode,
  onDebugModeChange,
  onClose,
}: SettingsPanelProps) {
  const [logs, setLogs] = useState<PersistentLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.sqlStudio['logs:read']({ limit: 500 });
      setLogs(result.entries ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取日志失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时刷新日志；打开期间每 2s 轮询一次（轻量）
  useEffect(() => {
    if (!open) return;
    void refreshLogs();
    const timer = window.setInterval(() => void refreshLogs(), 2000);
    return () => window.clearInterval(timer);
  }, [open, refreshLogs]);

  const handleClear = async () => {
    try {
      await window.sqlStudio['logs:clear']({ scope: 'all-managed-logs' });
      setLogs([]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空失败');
    }
  };

  const handleCopy = async () => {
    try {
      const header = `SQL Studio 持久日志（北京时间 ${formatBeijingTime(new Date().toISOString())}）\n共 ${logs.length} 条\n${'─'.repeat(60)}\n`;
      const text = header + logs.map(formatPersistentLogLine).join('\n');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert('复制失败：剪贴板不可用');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="设置" width={560} panelClassName="settings-panel">
      <div className="settings-body">
        {/* 调试模式 */}
        <section className="settings-section">
          <h4>调试模式</h4>
          <label className="settings-debug-toggle">
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => onDebugModeChange(e.target.checked)}
            />
            <span>开启调试模式（采集普通日志）</span>
          </label>
          <p className="settings-section-hint">
            持久日志由主进程落盘（userData/logs），重启后仍可查看；错误与警告始终记录。
          </p>
          <div className="settings-debug-log">
            <div className="settings-debug-log-head">
              <span className="settings-debug-log-title">
                <Bug size={13} /> 最近日志（{logs.length} 条{loading ? '…' : ''}）
              </span>
              <div className="settings-debug-actions">
                <button className="settings-debug-copy" onClick={() => void handleCopy()}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? '已复制' : '一键复制'}</span>
                </button>
                <button className="settings-debug-copy settings-debug-clear" onClick={() => void handleClear()} title="清空日志">
                  <Trash2 size={13} />
                  <span>清空</span>
                </button>
              </div>
            </div>
            {error && <p className="settings-debug-error">{error}</p>}
            <pre className="settings-debug-log-body">
              {logs.length === 0
                ? '（暂无日志，使用过程中产生的错误与调试信息将显示在这里）'
                : logs
                    .slice(-200)
                    .map(formatPersistentLogLine)
                    .join('\n')}
            </pre>
            <p className="settings-debug-hint">
              日志保存在主进程受控目录，不包含密码、API Key 与完整 SQL。
            </p>
          </div>
        </section>
      </div>
    </Modal>
  );
}