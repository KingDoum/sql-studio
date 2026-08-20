/**
 * 编辑器标签页（任务 9 ui-editor）。
 * 多标签条 + 顶部动作：新建/打开/保存/另存为；
 * 脏标记圆点、关闭确认、文件路径 tooltip。
 *
 * 纯展示组件：数据与动作由父级（App + workspace store）注入，
 * 便于单测（mock 回调 / window.confirm）。
 */
import { Plus, FilePlus2, FolderOpen, Save } from 'lucide-react';
import type { EditorTab } from '@shared/types';

export interface EditorTabsProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
}

export function EditorTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
}: EditorTabsProps) {
  const handleClose = (tab: EditorTab) => {
    if (
      tab.isDirty &&
      !window.confirm(`「${tab.title}」有未保存的修改，确定关闭吗？`)
    ) {
      return;
    }
    onClose(tab.id);
  };

  return (
    <div className="tabs-bar">
      <div className="tabs-actions">
        <button title="新建脚本" onClick={onNew}>
          <FilePlus2 size={13} />
          <span>新建</span>
        </button>
        <button title="打开脚本" onClick={onOpen}>
          <FolderOpen size={13} />
          <span>打开</span>
        </button>
        <button title="保存 (Ctrl+S)" onClick={onSave}>
          <Save size={13} />
          <span>保存</span>
        </button>
        <button title="另存为" onClick={onSaveAs}>
          另存为
        </button>
      </div>
      <div className="tabs-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? ' active' : ''}`}
            onClick={() => onSelect(tab.id)}
            title={tab.filePath ?? tab.title}
          >
            <span className="tab-title">{tab.title}</span>
            {tab.isDirty && <span className="tab-dirty" data-testid={`dirty-${tab.id}`} />}
            <button
              className="tab-close"
              data-testid={`close-${tab.id}`}
              title="关闭"
              onClick={(e) => {
                e.stopPropagation();
                handleClose(tab);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="tab-add"
          title="新建标签"
          data-testid="tab-add"
          onClick={onNew}
        >
          <Plus size={14} />
        </button>
        {tabs.length === 0 && <span className="tabs-empty">无打开的脚本</span>}
      </div>
    </div>
  );
}