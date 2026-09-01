// @vitest-environment jsdom
/**
 * AppearancePanel 外观页面测试（阶段 E：外观与 AI 限流）。
 *
 * 覆盖执行指令必须测试：
 * - 三个主题选项都能显示（深色/白天/钛灰）；
 * - 选择钛灰后触发 onThemeChange('titanium')（App 侧负责 dataset.theme 与持久化）；
 * - 当前主题状态正确标记（active 卡片）；
 * - 字号、字体设置继续生效（回调触发）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearancePanel } from '@renderer/components/AppearancePanel';

function renderPanel(props: Partial<Parameters<typeof AppearancePanel>[0]> = {}) {
  const onThemeChange = vi.fn();
  const onFontSizeChange = vi.fn();
  const onFontFamilyChange = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <AppearancePanel
      open
      theme="dark"
      fontSize={12}
      fontFamily="jetbrains"
      onThemeChange={onThemeChange}
      onFontSizeChange={onFontSizeChange}
      onFontFamilyChange={onFontFamilyChange}
      onClose={onClose}
      {...props}
    />,
  );
  return { onThemeChange, onFontSizeChange, onFontFamilyChange, onClose, ...utils };
}

describe('AppearancePanel', () => {
  it('三个主题选项都能显示（深色/白天/钛灰）', () => {
    renderPanel();
    expect(screen.getByText('外观')).toBeTruthy();
    expect(screen.getByText('深色')).toBeTruthy();
    expect(screen.getByText('白天')).toBeTruthy();
    expect(screen.getByText('钛灰')).toBeTruthy();
  });

  it('当前主题标记为 active（默认 dark）', () => {
    renderPanel();
    const darkCard = screen.getByText('深色').closest('button') as HTMLButtonElement;
    const lightCard = screen.getByText('白天').closest('button') as HTMLButtonElement;
    expect(darkCard.classList.contains('active')).toBe(true);
    expect(lightCard.classList.contains('active')).toBe(false);
  });

  it('选择钛灰 → onThemeChange(titanium)', () => {
    const { onThemeChange } = renderPanel();
    fireEvent.click(screen.getByText('钛灰'));
    expect(onThemeChange).toHaveBeenCalledWith('titanium');
  });

  it('选择白天 → onThemeChange(light)，且 app 层更新 activity', () => {
    const { onThemeChange } = renderPanel({ theme: 'titanium' });
    fireEvent.click(screen.getByText('白天'));
    expect(onThemeChange).toHaveBeenCalledWith('light');
  });

  it('字号滑块触发 onFontSizeChange', () => {
    const { onFontSizeChange } = renderPanel();
    const slider = document.querySelector('.appearance-font-range') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '16' } });
    expect(onFontSizeChange).toHaveBeenCalledWith(16);
  });

  it('字体风格选择触发 onFontFamilyChange', () => {
    const { onFontFamilyChange } = renderPanel();
    const select = document.querySelector('.appearance-font-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'firacode' } });
    expect(onFontFamilyChange).toHaveBeenCalledWith('firacode');
  });

  it('主题预览色块存在（每个主题 4 个 swatch）', () => {
    renderPanel();
    const swatches = document.querySelectorAll('.appearance-theme-swatch');
    expect(swatches.length).toBe(12); // 3 主题 × 4 色块
  });
});