/**
 * ExportMenu（任务 11 ui-export-history）。
 * 导出按钮（下拉菜单）：导出 Excel（全量/当前筛选）、导出 SQL INSERT。
 * 数据来自 workspace.execution 的当前活跃结果集。
 * 路径通过 window.prompt 输入（主进程暂未接 dialog，V2 可改）。
 */
import { useState, useRef, useCallback } from 'react';
import { Download } from 'lucide-react';
import { useWorkspace } from '@renderer/store/workspace';
import type { ExportExcelRequest, ExportInsertRequest } from '@shared/types';

export function ExportMenu() {
  const execution = useWorkspace((s) => s.execution);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const resultSet = execution?.result?.resultSets[0];
  const canExport = !!resultSet && resultSet.rows.length > 0;

  const close = useCallback(() => setOpen(false), []);

  const exportExcel = async (mode: 'full' | 'filtered') => {
    if (!resultSet) return;
    const filePath = window.prompt('输入导出路径（.xlsx）');
    if (!filePath) return;
    setExporting(true);
    try {
      // 筛选过的行从网格 visibleRows 获取？但 ExportMenu 无网格引用。
      // V1 总是导出全量结果集（包含筛选前的行）。
      // 若要导出筛选结果，需 ResultGrid 向上传递 filteredRows → workspace store 暂存。
      // 当前 V1 仅导出全量。
      const req: ExportExcelRequest = {
        options: { filePath: filePath.endsWith('.xlsx') ? filePath : `${filePath}.xlsx` },
        columns: resultSet.columns,
        rows: resultSet.rows,
      };
      await window.sqlStudio['export:excel'](req);
      window.alert(`导出成功：${filePath}`);
    } catch (err) {
      window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      close();
    }
  };

  const exportInsert = async () => {
    if (!resultSet) return;
    const tableName = window.prompt('目标表名');
    if (!tableName) return;
    const filePath = window.prompt('输入导出路径（.sql）');
    if (!filePath) return;
    setExporting(true);
    try {
      const req: ExportInsertRequest = {
        options: { filePath, tableName },
        columns: resultSet.columns,
        rows: resultSet.rows,
      };
      await window.sqlStudio['export:insert'](req);
      window.alert(`导出成功：${filePath}`);
    } catch (err) {
      window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      close();
    }
  };

  return (
    <div className="export-menu" ref={menuRef}>
      <button
        className="sql-editor-btn"
        disabled={!canExport || exporting}
        onClick={() => setOpen((v) => !v)}
        title="导出结果"
      >
        <Download size={13} />
        <span>导出</span>
      </button>
      {open && (
        <>
          <div className="export-backdrop" onClick={close} />
          <div className="export-dropdown">
            <button
              className="export-item"
              disabled={exporting}
              onClick={() => void exportExcel('full')}
            >
              导出 Excel（全量）
            </button>
            <button
              className="export-item"
              disabled={exporting}
              onClick={() => void exportInsert()}
            >
              导出 SQL INSERT
            </button>
          </div>
        </>
      )}
    </div>
  );
}