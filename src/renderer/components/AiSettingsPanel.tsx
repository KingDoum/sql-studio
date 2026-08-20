/**
 * AiSettingsPanel（V2：AI 补全设置弹窗）。
 * 配置 BaseURL / Model / API Key / 启用开关。
 * 数据通过 settings:getAiConfig / settings:setAiConfig IPC 与主进程同步。
 */
import { useEffect, useState } from 'react';
import { X, Brain } from 'lucide-react';
import type { AiConfig } from '@shared/types';

export interface AiSettingsPanelProps {
  open: boolean;
  onClose(): void;
  onSettingsChanged(): void;
}

export function AiSettingsPanel({ open, onClose, onSettingsChanged }: AiSettingsPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMsg(null);
    window.sqlStudio['settings:getAiConfig']()
      .then((cfg: AiConfig | null) => {
        if (cfg) {
          setEnabled(cfg.enabled);
          setBaseUrl(cfg.baseUrl);
          setModel(cfg.model);
          setApiKey(cfg.apiKey);
        }
      })
      .catch(() => setMsg('加载设置失败'))
      .finally(() => setLoading(false));
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await window.sqlStudio['settings:setAiConfig']({
        enabled,
        baseUrl: baseUrl.trim() || 'https://api.deepseek.com',
        model: model.trim() || 'deepseek-chat',
        apiKey: apiKey.trim(),
      });
      setMsg('设置已保存');
      onSettingsChanged();
    } catch (err) {
      setMsg(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <div className="modal-header">
          <h3><Brain size={16} style={{ marginRight: 6 }} /> AI 智能补全设置</h3>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body" style={{ padding: '12px 16px' }}>
          {loading ? (
            <div className="modal-loading">加载中…</div>
          ) : (
            <div className="ai-settings-form">
              <label className="ai-settings-label">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                启用 AI 行内补全（灰色预测）
              </label>
              <label className="ai-settings-field">
                <span>API Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                />
              </label>
              <label className="ai-settings-field">
                <span>模型</span>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                />
              </label>
              <label className="ai-settings-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                />
              </label>
              <div className="ai-settings-actions">
                <button className="ai-settings-btn primary" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? '保存中…' : '保存设置'}
                </button>
              </div>
              {msg && <p className={msg.includes('失败') ? 'form-error' : 'test-msg'}>{msg}</p>}
              <p className="ai-settings-hint">
                支持 OpenAI 兼容 API（DeepSeek、混元、通义千问等）。
                输入 SQL 前缀后自动请求 AI 补全建议，以灰色行内文字展示。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}