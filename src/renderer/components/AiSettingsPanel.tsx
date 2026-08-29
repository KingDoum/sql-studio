/**
 * AiSettingsPanel（V2：AI 补全设置弹窗，UI 重设计 S4 统一弹窗）。
 * 配置 BaseURL / Model / API Key / 启用开关。
 * 数据通过 settings:getAiConfig / settings:setAiConfig IPC 与主进程同步。
 * 主操作「保存设置」放在统一底部操作区（Modal footer）。
 */
import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import type { AiConfig } from '@shared/types';
import { Modal } from './Modal';

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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<><Brain size={16} /> AI 智能补全设置</>}
      width={460}
      footer={
        <button className="ai-settings-btn primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      }
    >
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
          {msg && <p className={msg.includes('失败') ? 'form-error' : 'test-msg'}>{msg}</p>}
          <p className="ai-settings-hint">
            支持 OpenAI 兼容 API（DeepSeek、混元、通义千问等）。
            输入 SQL 前缀后自动请求 AI 补全建议，以灰色行内文字展示。
          </p>
        </div>
      )}
    </Modal>
  );
}
