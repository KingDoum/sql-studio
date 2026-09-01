// @vitest-environment jsdom
/**
 * AiSettingsPanel 请求策略测试（阶段 B：外观与 AI 限流）。
 *
 * 覆盖执行指令必须测试：
 * - 四个参数正确回填；
 * - 修改后保存时 payload 包含新值；
 * - 非法值显示字段错误且不保存（保存按钮禁用）；
 * - 恢复默认只重置请求策略（不动协议/模型/API Key 输入）；
 * - 空 Key 保存不清空已有 Key（payload.apiKey = ''，主进程端保留密文）；
 * - public config 中始终没有 apiKey（阶段 3）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AiSettingsPanel } from '@renderer/components/AiSettingsPanel';
import type { AiPublicConfig } from '@shared/types';

const PUBLIC_CONFIG: AiPublicConfig = {
  enabled: true,
  baseUrl: 'https://api.deepseek.com/beta',
  model: 'deepseek-v4-pro',
  protocol: 'deepseek-fim',
  apiKeyConfigured: true,
  rateLimit: {
    debounceMs: 400,
    minRequestIntervalMs: 2500,
    rateLimitCooldownMs: 15_000,
    requestTimeoutMs: 12_000,
  },
};

/** 设置 window.sqlStudio mock，返回 setAiConfig 的调用记录。 */
function mockSqlStudio(config: AiPublicConfig | null = PUBLIC_CONFIG) {
  const setAiCalls: unknown[] = [];
  (window as unknown as Record<string, unknown>).sqlStudio = {
    'settings:getAiConfig': vi.fn(async () => config),
    'settings:setAiConfig': vi.fn(async (arg: unknown) => {
      setAiCalls.push(arg);
      return { saved: true };
    }),
  };
  return { setAiCalls };
}

function renderPanel() {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <AiSettingsPanel open onClose={onClose} onSettingsChanged={onChanged} />,
  );
  return { onChanged, onClose, ...utils };
}

/** 按 aria-label 找到请求策略输入框。 */
function rateInput(label: string): HTMLInputElement {
  return screen.getByLabelText(`${label}（毫秒）`) as HTMLInputElement;
}

beforeEach(() => {
  mockSqlStudio();
});
afterEach(() => vi.restoreAllMocks());

describe('AiSettingsPanel 请求策略（阶段 B）', () => {
  it('四个参数正确回填（来自 public config）', async () => {
    renderPanel();
    await screen.findByText('请求策略');
    expect(rateInput('输入防抖').value).toBe('400');
    expect(rateInput('最小请求间隔').value).toBe('2500');
    expect(rateInput('限流冷却时间').value).toBe('15000');
    expect(rateInput('请求超时').value).toBe('12000');
  });

  it('修改后保存时 payload 包含四个新值', async () => {
    const { setAiCalls } = mockSqlStudio();
    renderPanel();
    await screen.findByText('请求策略');

    fireEvent.change(rateInput('输入防抖'), { target: { value: '600' } });
    fireEvent.change(rateInput('最小请求间隔'), { target: { value: '3000' } });
    fireEvent.change(rateInput('限流冷却时间'), { target: { value: '20000' } });
    fireEvent.change(rateInput('请求超时'), { target: { value: '15000' } });

    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() => expect(setAiCalls).toHaveLength(1));
    const payload = setAiCalls[0] as Record<string, unknown>;
    expect(payload.rateLimit).toEqual({
      debounceMs: 600,
      minRequestIntervalMs: 3000,
      rateLimitCooldownMs: 20000,
      requestTimeoutMs: 15000,
    });
  });

  it('非法值（越界/非数字）显示字段错误且不保存', async () => {
    const { setAiCalls } = mockSqlStudio();
    renderPanel();
    await screen.findByText('请求策略');

    // 越界：低于最小值
    fireEvent.change(rateInput('输入防抖'), { target: { value: '10' } });
    await screen.findByText(/允许范围 150-3000 ms/);
    // 保存按钮应禁用
    const saveBtn = screen.getByText('保存设置').closest('button') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // 空输入（number input 可到达的非法状态，非数字字符会被输入框自身拒绝）
    fireEvent.change(rateInput('输入防抖'), { target: { value: '' } });
    await screen.findByText(/不能为空/);

    // 修复后保存恢复可用
    fireEvent.change(rateInput('输入防抖'), { target: { value: '500' } });
    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() => expect(setAiCalls).toHaveLength(1));
    expect((setAiCalls[0] as Record<string, unknown>).rateLimit).toMatchObject({ debounceMs: 500 });
  });

  it('非法值不能保存（直接点保存无效）', async () => {
    const { setAiCalls } = mockSqlStudio();
    renderPanel();
    await screen.findByText('请求策略');
    fireEvent.change(rateInput('输入防抖'), { target: { value: '999999' } });
    const saveBtn = screen.getByText('保存设置').closest('button') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.click(saveBtn);
    expect(setAiCalls).toHaveLength(0);
  });

  it('恢复默认只重置请求策略（协议/模型/API Key 输入不动）', async () => {
    const { setAiCalls } = mockSqlStudio();
    renderPanel();
    await screen.findByText('请求策略');

    // 用户修改四个字段 + 协议/模型
    fireEvent.change(rateInput('输入防抖'), { target: { value: '700' } });
    fireEvent.change(rateInput('最小请求间隔'), { target: { value: '5000' } });
    await waitFor(() => expect(rateInput('输入防抖').value).toBe('700'));

    // 点击恢复默认（在请求策略分组内）
    const group = screen.getByText('请求策略').closest('section') as HTMLElement;
    fireEvent.click(within(group).getByText('恢复默认'));

    // 四个字段回到默认
    expect(rateInput('输入防抖').value).toBe('400');
    expect(rateInput('最小请求间隔').value).toBe('2500');
    expect(rateInput('限流冷却时间').value).toBe('15000');
    expect(rateInput('请求超时').value).toBe('12000');

    // 保存后 payload 为默认策略
    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() => expect(setAiCalls).toHaveLength(1));
    expect((setAiCalls[0] as Record<string, unknown>).rateLimit).toEqual({
      debounceMs: 400,
      minRequestIntervalMs: 2500,
      rateLimitCooldownMs: 15000,
      requestTimeoutMs: 12000,
    });
  });

  it('空 Key 保存：payload.apiKey 为空字符串（主进程端保留旧密文）', async () => {
    const { setAiCalls } = mockSqlStudio({ ...PUBLIC_CONFIG, apiKeyConfigured: true });
    renderPanel();
    await screen.findByText('请求策略');
    // 不做任何 Key 输入，直接保存
    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() => expect(setAiCalls).toHaveLength(1));
    const payload = setAiCalls[0] as Record<string, unknown>;
    expect(payload.apiKey).toBe('');
  });

  it('public config 中始终没有 apiKey（阶段 3 边界）', async () => {
    expect((PUBLIC_CONFIG as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    // 组件内部不回显已有 Key
    renderPanel();
    await screen.findByText('请求策略');
    const keyInput = screen.getByLabelText(/API Key/i) as HTMLInputElement;
    expect(keyInput.value).toBe('');
  });
});