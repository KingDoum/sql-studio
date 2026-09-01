/**
 * AppearancePanel（外观页面：主题 + 字体，2026-09-01 外观升级新增）。
 *
 * 独立于通用设置（SettingsPanel 保留调试日志），提供：
 *  - 三种主题选择：深色 / 白天 / 钛灰，附当前主题状态与简单预览色块；
 *  - 字号（滑块）与编辑器字体风格选择；
 *  - 主题切换立即应用（写 document.documentElement.dataset.theme + 持久化 theme key）；
 *  - 字号/字体行为与既有设置一致（App 负责应用与持久化）。
 *
 * 视觉边界：简单色板 + 短标签，不做「卡片套卡片」；不使用渐变/玻璃/大装饰。
 */
import { Palette, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@shared/types';
import { Modal } from './Modal';

export interface AppearancePanelProps {
  open: boolean;
  theme: ThemeMode;
  fontSize: number;
  fontFamily: string;
  onThemeChange(theme: ThemeMode): void;
  onFontSizeChange(size: number): void;
  onFontFamilyChange(family: string): void;
  onClose(): void;
}

/** 主题选项：label + 图标 + 预览色块（背景/表面/主色三块 + 文本色）。 */
const THEME_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  icon: typeof Sun;
  swatches: string[];
}> = [
  { value: 'dark', label: '深色', icon: Moon, swatches: ['#16181d', '#1d2026', '#4f7fd9', '#e6e8ef'] },
  { value: 'light', label: '白天', icon: Sun, swatches: ['#f5f7fa', '#ffffff', '#3b6fd8', '#172033'] },
  { value: 'titanium', label: '钛灰', icon: Palette, swatches: ['#e8ebef', '#f7f8fa', '#4b6580', '#20252b'] },
];

const FONT_OPTIONS = [
  { value: 'jetbrains', label: 'JetBrains Mono' },
  { value: 'firacode', label: 'Fira Code' },
  { value: 'sourcecode', label: 'Source Code Pro' },
  { value: 'cascadia', label: 'Cascadia Code' },
  { value: 'system', label: '系统默认' },
];

export function AppearancePanel({
  open,
  theme,
  fontSize,
  fontFamily,
  onThemeChange,
  onFontSizeChange,
  onFontFamilyChange,
  onClose,
}: AppearancePanelProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<><Palette size={16} /> 外观</>}
      width={480}
      panelClassName="appearance-panel"
    >
      <div className="appearance-body">
        {/* 主题选择 */}
        <section className="appearance-section">
          <h4>主题</h4>
          <div className="appearance-theme-list">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  className={`appearance-theme-card${active ? ' active' : ''}`}
                  onClick={() => onThemeChange(opt.value)}
                  aria-pressed={active}
                >
                  <span className="appearance-theme-swatches" aria-hidden="true">
                    {opt.swatches.map((c) => (
                      <span key={c} className="appearance-theme-swatch" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="appearance-theme-card-label">
                    <Icon size={14} />
                    {opt.label}
                  </span>
                  {active && <span className="appearance-theme-check">✓</span>}
                </button>
              );
            })}
          </div>
          <p className="appearance-hint">当前主题：{THEME_OPTIONS.find((o) => o.value === theme)?.label ?? '深色'}。切换立即生效并自动保存。</p>
        </section>

        {/* 字体设置 */}
        <section className="appearance-section">
          <h4>字体</h4>
          <div className="appearance-font-row">
            <span className="appearance-font-label">字号</span>
            <input
              className="appearance-font-range"
              type="range"
              min={10}
              max={30}
              step={1}
              value={fontSize}
              onChange={(e) => onFontSizeChange(Number(e.target.value))}
            />
            <span className="appearance-font-value">{fontSize}px</span>
          </div>
          <div className="appearance-font-row">
            <span className="appearance-font-label">风格</span>
            <select
              className="appearance-font-select"
              value={fontFamily}
              onChange={(e) => onFontFamilyChange(e.target.value)}
            >
              {FONT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <p className="appearance-hint">字体设置同时应用于 SQL 编辑器。</p>
        </section>
      </div>
    </Modal>
  );
}