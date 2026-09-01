/**
 * AiSettingsPanel（V2：AI 补全设置弹窗，UI 重设计 S4 统一弹窗）。
 * 配置 补全协议 / BaseURL / Model / API Key / 启用开关。
 * 数据通过 settings:getAiConfig / settings:setAiConfig IPC 与主进程同步。
 * 主操作「保存设置」放在统一底部操作区（Modal footer）。
 *
 * 阶段 1（FIM 协议修复）：新增协议选择（DeepSeek FIM / OpenAI Chat）。
 * 阶段 3（API Key 安全）：
 *  - 加载设置时不再把 apiKey 放入 state（Renderer 拿到的也只是 AiPublicConfig，无 Key）；
 *  - 只有「是否已配置 Key」的布尔提示（apiKeyConfigured）；
 *  - 保存时空 Key = 保留旧 Key（主进程不覆盖密文），不能意外清空。
 */
import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import type { AiConfig, AiProtocol, AiPublicConfig } from '@shared/types';
import {
  defaultBaseUrlFor,
  defaultModelFor,
  inferAiProtocolFromBaseUrl,
} from '@shared/ai-protocol';
import { Modal } from './Modal';

export interface AiSettingsPanelProps {
  open: boolean;
  onClose(): void;
  onSettingsChanged(): void;
}

const PROTOCOL_OPTIONS: Array<{ value: AiProtocol; label: string }> = [
  { value: 'deepseek-fim', label: 'DeepSeek FIM（SQL 行内补全）' },
  { value: 'openai-chat', label: 'OpenAI Chat（兼容）' },
];

export function AiSettingsPanel({ open, onClose, onSettingsChanged }: AiSettingsPanelProps) {
  const [protocol, setProtocol] = useState<AiProtocol>('deepseek-fim');
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrlFor('deepseek-fim'));
  const [model, setModel] = useState(defaultModelFor('deepseek-fim'));
  /** 仅保存用户本次输入的新 Key；旧 Key 不进入 state（阶段 3）。 */
  const [apiKeyInput, setApiKeyInput] = useState('');
  /** 是否已配置 Key（来自 public 配置，仅布尔，不泄露内容）。 */
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMsg(null);
    setApiKeyInput('');
    window.sqlStudio['settings:getAiConfig']()
      .then((pub: AiPublicConfig | null) => {
        if (pub) {
          // 旧配置可能没有 protocol：按 baseUrl 推断，不破坏旧配置读取
          const p = pub.protocol ?? inferAiProtocolFromBaseUrl(pub.baseUrl);
          setProtocol(p);
          setEnabled(pub.enabled);
          setBaseUrl(pub.baseUrl || defaultBaseUrlFor(p));
          setModel(pub.model || defaultModelFor(p));
          setApiKeyConfigured(pub.apiKeyConfigured);
        } else {
          setApiKeyConfigured(false);
        }
      })
      .catch(() => setMsg('加载设置失败'))
      .finally(() => setLoading(false));
  }, [open]);

  /** 协议切换：若当前值仍是另一协议的默认值/空，则换成新协议默认；用户自定义值保留。 */
  const handleProtocolChange = (next: AiProtocol) => {
    setProtocol(next);
    const other = next === 'deepseek-fim' ? 'openai-chat' : 'deepseek-fim';
    setBaseUrl((cur) =>
      !cur || cur === defaultBaseUrlFor(other) || cur === defaultBaseUrlFor(next)
        ? defaultBaseUrlFor(next)
        : cur,
    );
    setModel((cur) =>
      !cur || cur === defaultModelFor(other) || cur === defaultModelFor(next)
        ? defaultModelFor(next)
        : cur,
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload: AiConfig = {
        enabled,
        baseUrl: baseUrl.trim() || defaultBaseUrlFor(protocol),
        model: model.trim() || defaultModelFor(protocol),
        apiKey: apiKeyInput.trim(), // 空 = 保留旧 Key（主进程不覆盖）
        protocol,
      };
      await window.sqlStudio['settings:setAiConfig'](payload);
      setMsg('设置已保存');
      setApiKeyInput('');
      // Key 状态：新 Key 填写后即为已配置；留空保持原状态
      setApiKeyConfigured(apiKeyConfigured || payload.apiKey.length > 0);
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
      width={480}
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
            <span>补全协议</span>
            <select
              value={protocol}
              onChange={(e) => handleProtocolChange(e.target.value as AiProtocol)}
              className="ai-settings-select"
            >
              {PROTOCOL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="ai-settings-field">
            <span>API Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={defaultBaseUrlFor(protocol)}
            />
          </label>
          <label className="ai-settings-field">
            <span>模型</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={defaultModelFor(protocol)}
            />
          </label>
          <label className="ai-settings-field">
            <span>API Key</span>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={apiKeyConfigured ? '已配置（留空保持不变）' : 'sk-...'}
            />
            {apiKeyConfigured && (
              <em className="ai-settings-key-state">✓ 已配置 API Key（再次输入可替换；留空则保留）</em>
            )}
          </label>
          {msg && <p className={msg.includes('失败') ? 'form-error' : 'test-msg'}>{msg}</p>}
          <p className="ai-settings-hint">
            {protocol === 'deepseek-fim'
              ? 'DeepSeek FIM 使用 /beta/completions 接口做 SQL 行内补全（prompt + suffix）。'
              : 'OpenAI 兼容 Chat 接口（/v1/chat/completions），供非 FIM 服务使用。'}
          </p>
        </div>
      )}
    </Modal>
  );
}