/**
 * DataPreviewModal（体验优化 §14：数据预览弹窗，UI 重设计 S4 统一弹窗）。
 * 预览表数据前 N 行：调用主进程 `schema:dataPreview`（已注册 IPC），
 * 用 ResultGrid 展示，不污染编辑器标签。对标 Navicat 右键预览。
 */
import { useEffect, useState } from 'react';
import type { QueryResultSet } from '@shared/types';
import { ResultGrid } from './ResultGrid';
import { Modal } from './Modal';

export interface DataPreviewModalProps {
  open: boolean;
  connectionId: string;
  database: string;
  table: string;
  onClose(): void;
}

export function DataPreviewModal({ open, connectionId, database, table, onClose }: DataPreviewModalProps) {
  const [result, setResult] = useState<QueryResultSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    window.sqlStudio['schema:dataPreview']({ connectionId, database, table, limit: 100 })
      .then((rs) => {
        if (!cancelled) setResult(rs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '预览失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, database, table]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      panelClassName="preview-modal"
      title={
        <>
          数据预览 <span className="preview-obj">`{database}`.`{table}`</span>
        </>
      }
    >
      <div className="preview-body">
        {loading && <div className="modal-loading">加载中…</div>}
        {error && <div className="modal-error">{error}</div>}
        {!loading && !error && result && (
          <ResultGrid columns={result.columns} rows={result.rows} />
        )}
        {!loading && !error && result && (
          <div className="preview-truncated">预览模式：最多显示前 100 行（完整数据请在编辑器中执行 SELECT 查看）</div>
        )}
      </div>
    </Modal>
  );
}
