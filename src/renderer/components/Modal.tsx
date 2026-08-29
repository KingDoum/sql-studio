/**
 * Modal（UI 重设计 S4：统一弹窗结构）。
 * 统一：遮罩（低透明度纯色）、面板宽度/圆角、标题栏、关闭按钮、Escape 关闭、
 *      遮罩点击关闭、底部操作区（footer）。
 *
 * 规范（实施规范 §5.10 / §6）：
 *  - 点击遮罩、关闭按钮、Escape 的行为一致（默认全部关闭）。
 *  - 主操作按钮统一放右下角或固定底部操作区（footer）。
 *  - 弹窗宽度通过 width 属性控制，窄窗口下自动收缩（max-width）。
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  /** 标题（H3 文本）。 */
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  /** 底部操作区（放在 footer，右对齐）。 */
  footer?: ReactNode;
  /** 面板宽度（像素），默认 560。 */
  width?: number;
  /** 自定义面板 className（如 preview-modal 需要固定宽度）。 */
  panelClassName?: string;
}

export function Modal({ open, title, onClose, children, footer, width = 560, panelClassName }: ModalProps) {
  // Escape 关闭（与遮罩点击、关闭按钮行为一致）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-panel${panelClassName ? ` ${panelClassName}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={panelClassName?.includes('preview') || panelClassName?.includes('export-table') ? undefined : { width }}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
