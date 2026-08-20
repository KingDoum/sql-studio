// @vitest-environment jsdom
/**
 * EditorTabs 组件测试（任务 9）。
 * 覆盖：标签渲染、脏标记、关闭确认、动作回调。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditorTabs } from '@renderer/components/EditorTabs';
import type { EditorTab } from '@shared/types';

function makeTabs(): EditorTab[] {
  return [
    { id: 't1', title: 'a.sql', sql: 'SELECT 1', filePath: '/x/a.sql', isDirty: false },
    { id: 't2', title: '未命名-1', sql: 'SELECT 2', isDirty: true },
  ];
}

const noop = () => {};

describe('EditorTabs', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染全部标签与动作按钮', () => {
    render(
      <EditorTabs
        tabs={makeTabs()}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        onOpen={() => {}}
        onSave={() => {}}
        onSaveAs={() => {}}
      />,
    );
    expect(screen.getByText('a.sql')).toBeTruthy();
    expect(screen.getByText('未命名-1')).toBeTruthy();
    expect(screen.getByText('新建')).toBeTruthy();
    expect(screen.getByText('打开')).toBeTruthy();
    expect(screen.getByText('保存')).toBeTruthy();
    expect(screen.getByText('另存为')).toBeTruthy();
  });

  it('活跃标签加 active 类；脏标签显示脏标记', () => {
    const { container } = render(
      <EditorTabs
        tabs={makeTabs()}
        activeTabId="t1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={noop}
        onOpen={noop}
        onSave={noop}
        onSaveAs={noop}
      />,
    );
    const tab1 = container.querySelector('.tab');
    expect(tab1?.className).toContain('active');
    expect(screen.getByTestId('dirty-t2')).toBeTruthy(); // 脏标记
    expect(screen.queryByTestId('dirty-t1')).toBeNull(); // 干净无标记
  });

  it('点击标签触发 onSelect', () => {
    const onSelect = vi.fn();
    render(
      <EditorTabs
        tabs={makeTabs()}
        activeTabId="t1"
        onSelect={onSelect}
        onClose={noop}
        onNew={noop}
        onOpen={noop}
        onSave={noop}
        onSaveAs={noop}
      />,
    );
    fireEvent.click(screen.getByText('未命名-1'));
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('关闭干净标签直接回调', () => {
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={makeTabs()}
        activeTabId="t1"
        onSelect={noop}
        onClose={onClose}
        onNew={noop}
        onOpen={noop}
        onSave={noop}
        onSaveAs={noop}
      />,
    );
    fireEvent.click(screen.getByTestId('close-t1'));
    expect(onClose).toHaveBeenCalledWith('t1');
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('关闭脏标签需确认，拒绝则不关闭', () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={makeTabs()}
        activeTabId="t2"
        onSelect={noop}
        onClose={onClose}
        onNew={noop}
        onOpen={noop}
        onSave={noop}
        onSaveAs={noop}
      />,
    );
    fireEvent.click(screen.getByTestId('close-t2'));
    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('动作按钮触发对应回调', () => {
    const onNew = vi.fn();
    const onOpen = vi.fn();
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(
      <EditorTabs
        tabs={[]}
        activeTabId={null}
        onSelect={noop}
        onClose={noop}
        onNew={onNew}
        onOpen={onOpen}
        onSave={onSave}
        onSaveAs={onSaveAs}
      />,
    );
    fireEvent.click(screen.getByText('新建'));
    fireEvent.click(screen.getByText('打开'));
    fireEvent.click(screen.getByText('保存'));
    fireEvent.click(screen.getByText('另存为'));
    expect(onNew).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalled();
    expect(onSaveAs).toHaveBeenCalled();
  });

  it('无标签时显示空提示', () => {
    render(
      <EditorTabs
        tabs={[]}
        activeTabId={null}
        onSelect={noop}
        onClose={noop}
        onNew={noop}
        onOpen={noop}
        onSave={noop}
        onSaveAs={noop}
      />,
    );
    expect(screen.getByText('无打开的脚本')).toBeTruthy();
  });
});