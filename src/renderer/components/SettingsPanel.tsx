/**
 * SettingsPanel（设置面板：主题切换 + 调试模式 + 调试日志）
 *
 * - 主题：深色 / 白天（本地 state + App 负责持久化到 settings）
 * - 调试模式：开关 + 实时日志列表 + 一键复制调试日志
 */
import { useEffect, useState } from 'react';
import { X, Sun, Moon, Bug, Copy, Check, Trash2 } from 'lucide-react';
import type { ThemeMode } from '@shared/types';
import { getDebugLogEntries, formatDebugLogText, ensureDebugLogging, clearDebugLogs, type DebugLogEntry } from '@renderer/lib/debug-log';

export interface SettingsPanelProps {
  open: boolean;
  theme: ThemeMode;
  debugMode: boolean;
  fontSize: number;
  fontFamily: string;
  onThemeChange(theme: ThemeMode): void;
  onDebugModeChange(enabled: boolean): void;
  onFontSizeChange(size: number): void;
  onFontFamilyChange(family: string): void;
  onClose(): void;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '白天', icon: Sun },
];

const FONT_OPTIONS = [
  { value: 'jetbrains', label: 'JetBrains Mono' },
  { value: 'firacode', label: 'Fira Code' },
  { value: 'sourcecode', label: 'Source Code Pro' },
  { value: 'cascadia', label: 'Cascadia Code' },
  { value: 'system', label: '系统默认' },
];

export function SettingsPanel({
  open,
  theme,
  debugMode,
  fontSize,
  fontFamily,
  onThemeChange,
  onDebugModeChange,
  onFontSizeChange,
  onFontFamilyChange,
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

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>设置</h3>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body settings-body">
          {/* 主题切换 */}
          <section className="settings-section">
            <h4>主题</h4>
            <div className="settings-theme-row">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = theme === opt.value;
                return (
                  <button
                    key={opt.value}
                    className={`settings-theme-btn${active ? ' active' : ''}`}
                    onClick={() => onThemeChange(opt.value)}
                  >
                    <Icon size={14} />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="settings-section-hint">选择界面主题，磨砂玻璃质感自动跟随</p>
          </section>

          {/* 字体设置 */}
          <section className="settings-section">
            <h4>字体</h4>
            <div className="settings-font-row">
              <span className="settings-font-label">字号</span>
              <input
                className="settings-font-range"
                type="range"
                min={10}
                max={18}
                step={1}
                value={fontSize}
                onChange={(e) => onFontSizeChange(Number(e.target.value))}
              />
              <span className="settings-font-value">{fontSize}px</span>
            </div>
            <div className="settings-font-row">
              <span className="settings-font-label">风格</span>
              <select
                className="settings-font-select"
                value={fontFamily}
                onChange={(e) => onFontFamilyChange(e.target.value)}
              >
                {FONT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </section>

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
                        .map((e) => `[${e.time.slice(11, 19)}] [${e.level.toUpperCase()}] ${e.message}${e.detail ? ` | ${e.detail}` : ''}`)
                        .join('\n')}
                </pre>
                <p className="settings-debug-hint">
                  开启后把日志复制给开发者，可快速定位问题。
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
