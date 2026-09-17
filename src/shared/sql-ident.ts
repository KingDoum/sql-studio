/**
 * SQL 标识符转义（Main 与 Renderer 共用；铁律 R5：安全相关逻辑单一来源）。
 *
 * 收敛原因：此前项目里有 **3 份**转义实现，且两个**同名函数语义不同**
 *   - `main/services/sql-exporter.ts` 的 `escapeIdent` → 转义 **并** 加反引号
 *   - `renderer/lib/sql-utils.ts` 的 `escapeIdent` → **只**转义，不包裹
 *   - `main/services/schema-cache.ts` 的 `esc`         → 只转义，不包裹
 * 跨层复制代码时极易得到错层的引号。因此这里把语义写进函数名：
 *   - `escapeIdentRaw`    只转义，不包裹（调用方自己加引号）
 *   - `quoteIdent`        转义 + 反引号包裹，可直接拼进 SQL
 *   - `quoteQualifiedIdent` 解析 `db.table`（≤2 段）并逐段校验 + 包裹
 *
 * 新增使用标识符的地方**一律引用本模块**，不要再在业务文件里写 `replace(/`/g, ...)`。
 */

/** MySQL 中标识符内嵌反引号写作两个反引号。只转义，不包裹。 */
export function escapeIdentRaw(name: string): string {
  return String(name).replace(/`/g, '``');
}

/** 转义 + 反引号包裹：`a``b`。可直接拼进 SQL。 */
export function quoteIdent(name: string): string {
  return `\`${escapeIdentRaw(name)}\``;
}

/** 标识符内不允许的结构字符（语句分隔 / 括号 / 换行）。 */
const FORBIDDEN_IDENT_CHARS = /[;()\n\r]/;

/**
 * 把用户输入的「表名」解析为安全标识符：
 * - 仅允许普通表名（`table`）或 `database.table` 两段；多余点号或空段视为错误；
 * - 任一段含 `;` `(` `)` 换行等结构字符即抛错，禁止把 SQL 片段当标识符拼进输出；
 * - 每段分别 `quoteIdent` 后以 `.` 连接。
 *
 * @throws 表名为空 / 段数 > 2 / 含非法字符
 */
export function quoteQualifiedIdent(tableName: string): string {
  const trimmed = String(tableName ?? '').trim();
  if (!trimmed) throw new Error('导出表名为空');
  const parts = trimmed.split('.');
  if (parts.length > 2) {
    throw new Error(`无效表名: ${tableName}`);
  }
  return parts
    .map((p) => {
      const seg = p.trim();
      if (!seg) throw new Error(`无效表名: ${tableName}`);
      if (FORBIDDEN_IDENT_CHARS.test(seg)) {
        throw new Error(`表名包含非法字符: ${tableName}`);
      }
      return quoteIdent(seg);
    })
    .join('.');
}
