/**
 * SettingsPanel（设置面板：调试模式 + 调试日志，UI 重设计 S4 统一弹窗）
 *
 * 外观与 AI 限流升级（2026-09-01）：
 *  - 主题与字体设置已迁移至独立 `AppearancePanel`（顶部应用栏「外观」入口打开）；
 *  - 本面板只保留「调试模式」开关 + 实时日志 + 一键复制/清空；
 *  - 不再维护第二套主题/字体状态（架构：外观状态唯一来源在 App + AppearancePanel）。
 */
import { useEffect, useState } from 'react';
import { Bug, Copy, Check, Trash2 } from 'lucide-react';
import { getDebugLogEntries, formatDebugLogText, formatLogEntryLine, clearDebugLogs, type DebugLogEntry } from '@renderer/lib/debug-log';
import { Modal } from './Modal';

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
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [copied, setCopied] = useState(false);

  // 打开时刷新日志；调试模式下每 2s 轮询一次（轻量）
  useEffect(() => {
    if (!open) return;
    setLogs(getDebugLogEntries());
    if (!debugMode) return;
    const timer = window.setInterval(() => setLogs(getDebugLogEntries()), 2000);
    return () => window.clearInterval(timer);
  }, [open, debugMode]);

  const handleClear = () => {
    clearDebugLogs();
    setLogs([]);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatDebugLogText());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.alert('复制失败：剪贴板不可用');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="设置" width={520} panelClassName="settings-panel">
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
            <span>开启调试模式（显示日志）</span>
          </label>
          <p className="settings-section-hint">主题与字体设置已移至顶部「外观」入口。</p>
          {debugMode && (
            <div className="settings-debug-log">
              <div className="settings-debug-log-head">
                <span className="settings-debug-log-title">
                  <Bug size={13} /> 最近日志（{logs.length} 条）
                </span>
                <div className="settings-debug-actions">
                  <button className="settings-debug-copy" onClick={() => void handleCopy()}>
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copied ? '已复制' : '一键复制'}</span>
                  </button>
                  <button className="settings-debug-copy settings-debug-clear" onClick={handleClear} title="清空日志">
                    <Trash2 size={13} />
                    <span>清空</span>
                  </button>
                </div>
              </div>
              <pre className="settings-debug-log-body">
                {logs.length === 0
                  ? '（暂无日志，使用过程中产生的 console / 错误将显示在这里）'
                  : logs
                      .slice(-200)
                      .map(formatLogEntryLine)
                      .join('\n')}
              </pre>
              <p className="settings-debug-hint">
                开启后把日志复制给开发者，可快速定位问题。
              </p>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}