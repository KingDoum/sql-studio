/**
 * 文件名工具（导出 / 另存为的默认文件名共用）。
 *
 * 目的：默认文件名自动带「日期_时间」，用户不想起名时可直接回车保存。
 * 纯函数、无副作用，便于单测。
 */

/**
 * 生成「日期_时间」后缀（**本地时间**，文件名安全）：形如 `20260916_173045`。
 * 不能含 `:`（Windows 文件名非法字符），故时分秒连写、用下划线分隔日期与时间。
 */
export function timestampSuffix(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}_${time}`;
}

/**
 * 生成带时间戳的文件名：`${base}_${YYYYMMDD_HHmmss}.${ext}`。
 * 例：`withTimestamp('导出结果', 'xlsx')` → `导出结果_20260916_173045.xlsx`。
 * ext 允许带或不带前导点（`.xlsx` / `xlsx`）。
 */
export function withTimestamp(base: string, ext: string, d: Date = new Date()): string {
  const cleanExt = ext.replace(/^\./, '');
  return `${base}_${timestampSuffix(d)}.${cleanExt}`;
}
