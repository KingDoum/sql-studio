/**
 * Modal（UI 重设计 S4：统一弹窗结构）。
 * 统一：遮罩（低透明度纯色）、面板宽度/圆角、标题栏、关闭按钮、Escape 关闭、
 *      遮罩点击关闭、底部操作区（footer）。
 *
 * 规范（实施规范 §5.10 / §6 / §8）：
 *  - 点击遮罩、关闭按钮、Escape 的行为一致（默认全部关闭）。
 *  - 主操作按钮统一放右下角或固定底部操作区（footer）。
 *  - 弹窗宽度：默认 560px；传入 width 用内联宽度；依赖 CSS 宽度（如 preview/export-table
 *    面板用固定 CSS 类）时传 panelClassName 且不传 width。
 *  - 可访问性：role=dialog + aria-modal + aria-labelledby 关联标题；打开时聚焦面板。
 */
import { useEffect, useId, useRef } from 'react';
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
  /** 面板宽度（像素）。传此值用内联宽度；不传则用 CSS 宽度（需配合 panelClassName）。 */
  width?: number;
  /** 自定义面板 className（如 preview-modal 需要固定宽度）。 */
  panelClassName?: string;
}

export function Modal({ open, title, onClose, children, footer, width, panelClassName }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape 关闭（与遮罩点击、关闭按钮行为一致）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时聚焦面板（键盘用户可从弹窗继续操作）
  useEffect(() => {
    if (!open) return;
    // 延迟聚焦，避免覆盖子组件 autoFocus 输入框
    const t = window.setTimeout(() => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      panelRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal-panel${panelClassName ? ` ${panelClassName}` : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={width !== undefined ? { width } : undefined}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
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
