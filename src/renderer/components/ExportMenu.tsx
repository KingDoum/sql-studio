/**
 * ExportMenu（任务 11 ui-export-history，体验优化 §14 增强）。
 * 导出按钮（下拉菜单）：导出 Excel（全量）、导出 SQL INSERT。
 * 数据来自 workspace.execution 的当前活跃结果集。
 *
 * 体验优化（2026-08-20）：
 *  - 路径选择改用 Electron 原生保存对话框（dialog:showSaveDialog），
 *    替代 window.prompt（Electron 中 prompt 返回 null → 导出静默失败）。
 *  - 导出目录持久化到 settings (lastExportDir)，下次导出默认定位到该目录。
 */
import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useWorkspace } from '@renderer/store/workspace';
import type { ExportExcelRequest, ExportInsertRequest, ExportCsvRequest } from '@shared/types';

const LAST_EXPORT_DIR_KEY = 'lastExportDir';

export function ExportMenu() {
  const execution = useWorkspace((s) => s.execution);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pendingInsert, setPendingInsert] = useState(false);
  const [tableName, setTableName] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);

  const resultSet = execution?.result?.resultSets[0];
  const canExport = !!resultSet && resultSet.rows.length > 0;

  // 读取上一次导出目录（持久化：settings 表）
  useEffect(() => {
    void window.sqlStudio['settings:get']({ key: LAST_EXPORT_DIR_KEY }).then((dir) => {
      if (dir) lastDirRef.current = dir;
    });
  }, []);

  const lastDirRef = useRef<string>('');

  const close = () => setOpen(false);

  /** 弹出原生保存对话框，返回路径；取消返回 null。 */
  const pickSavePath = async (title: string, filename: string, filters: Array<{ name: string; extensions: string[] }>): Promise<string | null> => {
    // 渲染进程（contextIsolation + nodeIntegration:false）不可直接用 process.platform，
    // 用 navigator.userAgent 判断平台（Electron 环境安全）
    let defaultPath: string;
    try {
      const isWin = /Windows/i.test(window.navigator.userAgent);
      const sep = isWin ? '\\' : '/';
      defaultPath = lastDirRef.current ? `${lastDirRef.current.replace(/[\\/]$/, '')}${sep}${filename}` : filename;
    } catch {
      defaultPath = filename;
    }
    try {
      const filePath = await window.sqlStudio['dialog:showSaveDialog']({ title, defaultPath, filters });
      return filePath;
    } catch (err) {
      window.alert(`无法打开保存对话框：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  /** 导出成功后：记住目录 + 用户可见反馈。 */
  const onExportSuccess = (filePath: string) => {
    const dir = filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    if (dir) {
      lastDirRef.current = dir;
      void window.sqlStudio['settings:set']({ key: LAST_EXPORT_DIR_KEY, value: dir });
    }
    window.alert(`导出成功：\n${filePath}`);
    // 在文件管理器中定位文件（静默，不阻塞）
    void window.sqlStudio['shell:showItemInFolder']({ path: filePath }).catch(() => {});
  };

  const exportExcel = async () => {
    if (!resultSet) return;
    let filePath: string | null = null;
    try {
      filePath = await pickSavePath('导出 Excel', '导出结果.xlsx', [
        { name: 'Excel 文件', extensions: ['xlsx'] },
      ]);
    } catch {
      filePath = null;
    }
    if (!filePath) return;
    setExporting(true);
    try {
      const req: ExportExcelRequest = {
        options: { filePath: filePath.endsWith('.xlsx') ? filePath : `${filePath}.xlsx` },
        columns: resultSet.columns,
        rows: resultSet.rows,
      };
      await window.sqlStudio['export:excel'](req);
      onExportSuccess(req.options.filePath);
    } catch (err) {
      window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      close();
    }
  };

  const exportCsv = async () => {
    if (!resultSet) return;
    let filePath: string | null = null;
    try {
      filePath = await pickSavePath('导出 CSV', '导出结果.csv', [
        { name: 'CSV 文件', extensions: ['csv'] },
      ]);
    } catch {
      filePath = null;
    }
    if (!filePath) return;
    setExporting(true);
    try {
      const req: ExportCsvRequest = {
        options: { filePath: filePath.endsWith('.csv') ? filePath : `${filePath}.csv` },
        columns: resultSet.columns,
        rows: resultSet.rows,
      };
      await window.sqlStudio['export:csv'](req);
      onExportSuccess(req.options.filePath);
    } catch (err) {
      window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      close();
    }
  };

  const exportInsert = async () => {
    if (!resultSet) return;
    setPendingInsert(true);
    close();
  };

  const doExportInsert = async () => {
    if (!resultSet || !tableName.trim()) return;
    setExporting(true);
    setPendingInsert(false);
    try {
      const filePath = await pickSavePath('导出 SQL INSERT', `${tableName.trim()}.sql`, [
        { name: 'SQL 文件', extensions: ['sql'] },
      ]);
      if (!filePath) return; // 取消保存对话框：finally 统一复位
      const req: ExportInsertRequest = {
        options: { filePath, tableName: tableName.trim() },
        columns: resultSet.columns,
        rows: resultSet.rows,
      };
      await window.sqlStudio['export:insert'](req);
      onExportSuccess(filePath);
    } catch (err) {
      window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      setTableName('');
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
        <span>{exporting ? '导出中…' : '导出'}</span>
      </button>
      {open && resultSet && (
        <>
          <div className="export-backdrop" onClick={close} />
          <div className="export-dropdown">
            <button
              className="export-item"
              disabled={exporting}
              onClick={() => void exportExcel()}
              title={resultSet.rows.length > 10000 ? '数据量较大（' + resultSet.rows.length.toLocaleString() + ' 行），导出可能需要一些时间，请勿重复点击' : undefined}
            >
              导出 Excel（全量）
              {resultSet.rows.length > 10000 && (
                <span className="export-item-hint">
                  {resultSet.rows.length.toLocaleString()} 行
                </span>
              )}
            </button>
            <button
              className="export-item"
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              导出 CSV
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
      {pendingInsert && (
        <div className="modal-overlay" onClick={() => setPendingInsert(false)}>
          <div className="modal-panel export-table-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>导出 SQL INSERT</h3>
              <button className="modal-close" onClick={() => setPendingInsert(false)} title="关闭">
                ✕
              </button>
            </div>
            <div className="modal-body export-table-body">
              <label className="export-table-label">
                目标表名
                <input
                  className="export-table-input"
                  value={tableName}
                  autoFocus
                  placeholder="如 orders"
                  onChange={(e) => setTableName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doExportInsert();
                  }}
                />
              </label>
            </div>
            <div className="export-table-actions">
              <button className="export-table-btn" onClick={() => setPendingInsert(false)}>
                取消
              </button>
              <button
                className="export-table-btn primary"
                disabled={!tableName.trim() || exporting}
                onClick={() => void doExportInsert()}
              >
                {exporting ? '导出中…' : '下一步'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}