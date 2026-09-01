/**
 * AiSettingsPanel（V2：AI 补全设置弹窗，UI 重设计 S4 统一弹窗）。
 * 配置 补全协议 / BaseURL / Model / API Key / 启用开关 / 请求策略（限流参数）。
 * 数据通过 settings:getAiConfig / settings:setAiConfig IPC 与主进程同步。
 * 主操作「保存设置」放在统一底部操作区（Modal footer）。
 *
 * 阶段 1（FIM 协议修复）：新增协议选择（DeepSeek FIM / OpenAI Chat）。
 * 阶段 3（API Key 安全）：
 *  - 加载设置时不再把 apiKey 放入 state（Renderer 拿到的也只是 AiPublicConfig，无 Key）；
 *  - 只有「是否已配置 Key」的布尔提示（apiKeyConfigured）；
 *  - 保存时空 Key = 保留旧 Key（主进程不覆盖密文），不能意外清空。
 * 阶段 B（外观与 AI 限流）：新增「请求策略」分组：
 *  - 四个参数（防抖/最小间隔/冷却/超时）使用带毫秒单位的 number 输入；
 *  - 输入过程中保持原始字符串（允许编辑），保存前数字化/整数化/范围校验，
 *    非法值在字段旁显示错误且禁用保存按钮；
 *  - 「恢复默认」只重置四个请求策略参数，不清空协议、模型和 API Key。
 */
import { useEffect, useMemo, useState } from 'react';
import { Brain, RotateCcw } from 'lucide-react';
import type { AiConfig, AiProtocol, AiPublicConfig, AiRateLimitConfig } from '@shared/types';
import {
  defaultBaseUrlFor,
  defaultModelFor,
  inferAiProtocolFromBaseUrl,
  DEFAULT_AI_RATE_LIMIT_CONFIG,
  AI_RATE_LIMIT_RANGES,
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

/** 请求策略字段元信息（label + 作用说明，文案来自执行指令）。 */
const RATE_LIMIT_FIELDS: Array<{ key: keyof AiRateLimitConfig; label: string; hint: string }> = [
  { key: 'debounceMs', label: '输入防抖', hint: '停止输入后等待多久再请求 AI。' },
  { key: 'minRequestIntervalMs', label: '最小请求间隔', hint: '限制连续请求频率，防止触发服务端限流。' },
  { key: 'rateLimitCooldownMs', label: '限流冷却时间', hint: '收到 429 后暂停请求多久。' },
  { key: 'requestTimeoutMs', label: '请求超时', hint: '超过该时间没有响应就放弃本次请求。' },
];

/** 校验输入字符串：空/非数字/非整数/越界 → 返回错误文案；合法 → null。 */
function validateRateLimitInput(key: keyof AiRateLimitConfig, raw: string): string | null {
  const s = raw.trim();
  if (s === '') return '不能为空';
  const n = Number(s);
  if (!Number.isFinite(n)) return '必须是数字';
  if (!Number.isInteger(n)) return '必须是整数（毫秒）';
  const { min, max } = AI_RATE_LIMIT_RANGES[key];
  if (n < min || n > max) return `允许范围 ${min}-${max} ms`;
  return null;
}

/** 字符串输入 → 数字配置（仅在全部合法时调用）。 */
function parseRateLimitInputs(
  inputs: Record<keyof AiRateLimitConfig, string>,
): AiRateLimitConfig {
  return {
    debounceMs: Number(inputs.debounceMs.trim()),
    minRequestIntervalMs: Number(inputs.minRequestIntervalMs.trim()),
    rateLimitCooldownMs: Number(inputs.rateLimitCooldownMs.trim()),
    requestTimeoutMs: Number(inputs.requestTimeoutMs.trim()),
  };
}

/** 数字配置 → 字符串输入。 */
function toInputs(cfg: AiRateLimitConfig): Record<keyof AiRateLimitConfig, string> {
  return {
    debounceMs: String(cfg.debounceMs),
    minRequestIntervalMs: String(cfg.minRequestIntervalMs),
    rateLimitCooldownMs: String(cfg.rateLimitCooldownMs),
    requestTimeoutMs: String(cfg.requestTimeoutMs),
  };
}

export function AiSettingsPanel({ open, onClose, onSettingsChanged }: AiSettingsPanelProps) {
  const [protocol, setProtocol] = useState<AiProtocol>('deepseek-fim');
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrlFor('deepseek-fim'));
  const [model, setModel] = useState(defaultModelFor('deepseek-fim'));
  /** 仅保存用户本次输入的新 Key；旧 Key 不进入 state（阶段 3）。 */
  const [apiKeyInput, setApiKeyInput] = useState('');
  /** 是否已配置 Key（来自 public 配置，仅布尔，不泄露内容）。 */
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  /** 请求策略输入（原始字符串，编辑过程不丢状态）。 */
  const [rateLimitInputs, setRateLimitInputs] = useState<Record<keyof AiRateLimitConfig, string>>(
    toInputs(DEFAULT_AI_RATE_LIMIT_CONFIG),
  );
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
          // 请求策略：public 配置已归一化；缺失时补默认
          setRateLimitInputs(toInputs({ ...DEFAULT_AI_RATE_LIMIT_CONFIG, ...(pub.rateLimit ?? {}) }));
        } else {
          setApiKeyConfigured(false);
          setRateLimitInputs(toInputs(DEFAULT_AI_RATE_LIMIT_CONFIG));
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

  /** 请求策略错误表：key → 错误文案（null = 合法）；任一字段非法则禁用保存。 */
  const rateLimitErrors = useMemo(() => {
    const errs: Partial<Record<keyof AiRateLimitConfig, string>> = {};
    for (const f of RATE_LIMIT_FIELDS) {
      const e = validateRateLimitInput(f.key, rateLimitInputs[f.key]);
      if (e) errs[f.key] = e;
    }
    return errs;
  }, [rateLimitInputs]);
  const hasRateLimitError = Object.values(rateLimitErrors).some(Boolean);

  const handleRateLimitInput = (key: keyof AiRateLimitConfig, value: string) => {
    setRateLimitInputs((cur) => ({ ...cur, [key]: value }));
  };

  /** 恢复默认：只重置四个请求策略参数，不清空协议、模型和 API Key。 */
  const handleRestoreRateLimit = () => {
    setRateLimitInputs(toInputs(DEFAULT_AI_RATE_LIMIT_CONFIG));
    setMsg(null);
  };

  const handleSave = async () => {
    if (hasRateLimitError) return; // 非法值不能保存
    setSaving(true);
    setMsg(null);
    try {
      const payload: AiConfig = {
        enabled,
        baseUrl: baseUrl.trim() || defaultBaseUrlFor(protocol),
        model: model.trim() || defaultModelFor(protocol),
        apiKey: apiKeyInput.trim(), // 空 = 保留旧 Key（主进程不覆盖）
        protocol,
        rateLimit: parseRateLimitInputs(rateLimitInputs),
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
      width={520}
      footer={
        <button
          className="ai-settings-btn primary"
          onClick={() => void handleSave()}
          disabled={saving || hasRateLimitError}
          title={hasRateLimitError ? '请先修正请求策略中的非法值' : undefined}
        >
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

          {/* 请求策略（阶段 B：AI 限流参数） */}
          <section className="ai-settings-rate-group">
            <div className="ai-settings-rate-head">
              <h5>请求策略</h5>
              <button
                type="button"
                className="ai-settings-restore-btn"
                onClick={handleRestoreRateLimit}
                title="只恢复四个请求策略参数（不动协议、模型和 API Key）"
              >
                <RotateCcw size={12} /> 恢复默认
              </button>
            </div>
            <p className="ai-settings-rate-desc">控制客户端请求频率，避免触发服务端限流。单位均为毫秒。</p>
            {RATE_LIMIT_FIELDS.map((f) => {
              const err = rateLimitErrors[f.key];
              const range = AI_RATE_LIMIT_RANGES[f.key];
              return (
                <label key={f.key} className={`ai-settings-field ai-settings-rate-field${err ? ' has-error' : ''}`}>
                  <span className="ai-settings-rate-label">
                    {f.label}
                    <em className="ai-settings-rate-unit-range">（{range.min}-{range.max} ms）</em>
                  </span>
                  <div className="ai-settings-rate-input-row">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={range.min}
                      max={range.max}
                      step={1}
                      value={rateLimitInputs[f.key]}
                      onChange={(e) => handleRateLimitInput(f.key, e.target.value)}
                      aria-label={`${f.label}（毫秒）`}
                    />
                    <span className="ai-settings-rate-unit-suffix">ms</span>
                  </div>
                  {err ? (
                    <em className="ai-settings-rate-error">{err}</em>
                  ) : (
                    <em className="ai-settings-rate-hint">{f.hint}</em>
                  )}
                </label>
              );
            })}
          </section>

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