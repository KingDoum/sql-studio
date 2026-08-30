/**
 * 命名收藏文件库（偏差决策 D1，替代旧项目 history.py 的 saved_queries JSON）。
 *
 * 每条收藏 = `queries/` 文件夹下以「收藏名.sql」命名的文件：
 *   - 文件名即收藏名（去 .sql 后缀）。
 *   - 文件顶部 `--` 注释块存元信息（name/connection/tags/createdAt），
 *     注释块与正文之间空一行分隔；正文为纯 SQL，文件本身可被编辑器直接打开运行。
 *   - 元信息缺省时的兜底：name 回退文件名；createdAt/updatedAt 回退文件 mtime。
 *
 * 这样收藏一目了然地躺在文件系统里，用户可直接在资源管理器浏览、grep 搜索、双击复用，
 * 而不是只出现在网页内嵌面板（旧项目痛点）。
 *
 * 依赖注入：构造时传入收藏根目录（默认 userData/queries），便于单测用临时目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FavoriteItem, FavoriteSaveRequest } from '@shared/types';

export const DEFAULT_FAVORITES_DIR_NAME = 'queries';

/** 注释块每行前缀，如 `-- name: 每日活跃用户`。 */
const HEADER_PREFIX = '-- ';

/** 文件名最大长度（不含 .sql 后缀），防止 ENAMETOOLONG。 */
const MAX_FILE_NAME_LENGTH = 100;

/**
 * 文件名安全化：去除对路径有危险的字符，避免目录穿越与非法文件名。
 * 保留中文、字母、数字、空格、点、下划线、连字符；其余替换为下划线。
 * 额外处理：Windows 保留设备名、纯点名称、超长名称。
 */
function sanitizeFileName(name: string): string {
  let cleaned = name
    .replace(/[\/\\:*?"<>|]/g, '_') // 文件系统保留字符
    .replace(/\s+/g, ' ') // 折叠多余空白
    .trim();
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含扩展名形式）加前缀，避免设备名解析
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  // 空名 / 纯点（. 或 ..）→ 兜底名
  if (!cleaned || /^\.+$/.test(cleaned)) return '未命名收藏';
  // 超长名称截断（保留尾部有效字符，去除截断残留的尾点/空白）
  if (cleaned.length > MAX_FILE_NAME_LENGTH) {
    cleaned = cleaned
      .slice(0, MAX_FILE_NAME_LENGTH)
      .replace(/[.\s]+$/, '') || '未命名收藏';
  }
  return cleaned;
}

/** 取「收藏名」对应的 .sql 文件名（确保 .sql 后缀）。 */
function toFileName(name: string): string {
  const base = sanitizeFileName(name);
  return base.toLowerCase().endsWith('.sql') ? base : `${base}.sql`;
}

/**
 * 重名处理：若 `<dir>/<name>.sql` 已存在，则在文件名末尾追加 ` (2)` / ` (3)` …。
 * 返回不冲突的绝对文件路径。
 */
function resolveNonCollidingPath(dir: string, fileName: string): string {
  const target = path.join(dir, fileName);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let i = 2;
  let candidate = path.join(dir, `${stem} (${i})${ext}`);
  while (fs.existsSync(candidate)) {
    i += 1;
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/** 解析 .sql 文件顶部注释块 → 元信息 + 纯 SQL 正文。 */
function parseFile(content: string): {
  meta: { name?: string; connectionId?: string; tags?: string[]; createdAt?: string };
  sql: string;
} {
  const lines = content.split(/\r?\n/);
  const meta: { name?: string; connectionId?: string; tags?: string[]; createdAt?: string } = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    // 注释块结束：遇到空行或第一个非 `-- ` 注释行即停止
    if (line.trim() === '') break;
    if (!line.startsWith('--')) break;
    const body = line.slice(2).trim(); // 去 `--`
    const idx = body.indexOf(':');
    if (idx === -1) continue;
    const key = body.slice(0, idx).trim();
    const value = body.slice(idx + 1).trim();
    if (key === 'name') meta.name = value;
    else if (key === 'connection') meta.connectionId = value || undefined;
    else if (key === 'tags') meta.tags = value ? value.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : [];
    else if (key === 'createdAt') meta.createdAt = value || undefined;
  }
  // 跳过注释块后的空行，取真正正文
  let sqlStart = i;
  while (sqlStart < lines.length && lines[sqlStart].trim() === '') sqlStart += 1;
  const sql = lines.slice(sqlStart).join('\n').replace(/\s+$/, '');
  return { meta, sql };
}

/** 把元信息 + SQL 序列化为带注释块的文件内容。 */
function serializeFile(req: FavoriteSaveRequest, createdAtIso: string): string {
  const blocks: string[] = [];
  blocks.push(`${HEADER_PREFIX}name: ${req.name}`);
  if (req.connectionId) blocks.push(`${HEADER_PREFIX}connection: ${req.connectionId}`);
  if (req.tags && req.tags.length > 0) blocks.push(`${HEADER_PREFIX}tags: ${req.tags.join(', ')}`);
  blocks.push(`${HEADER_PREFIX}createdAt: ${createdAtIso}`);
  return `${blocks.join('\n')}\n\n${req.sql.replace(/\s*$/, '')}\n`;
}

export class FavoritesStore {
  private readonly dir: string;

  /** dir 缺省为 undefined；调用方（主进程）应传入 app.getPath('userData')/queries。 */
  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_FAVORITES_DIR_NAME;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 列出全部收藏（扫描目录，按 updatedAt 倒序）。 */
  listFavorites(): FavoriteItem[] {
    this.ensureDir();
    const files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.sql'));
    const items = files.map((fileName) => {
      const filePath = path.join(this.dir, fileName);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const { meta, sql } = parseFile(content);
      const name = meta.name ?? fileName.replace(/\.sql$/i, '');
      const createdAt = meta.createdAt ? Date.parse(meta.createdAt) || stat.mtimeMs : stat.mtimeMs;
      return {
        filePath,
        name,
        sql,
        connectionId: meta.connectionId,
        tags: meta.tags,
        createdAt,
        updatedAt: stat.mtimeMs,
      } satisfies FavoriteItem;
    });
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 保存收藏（文件名安全化 + 重名加序号）；返回落盘后的 FavoriteItem。 */
  saveFavorite(req: FavoriteSaveRequest): FavoriteItem {
    this.ensureDir();
    const fileName = toFileName(req.name);
    const filePath = resolveNonCollidingPath(this.dir, fileName);
    // 重名冲突时（文件名带序号），meta.name 跟随实际文件名，保证列表显示与删除一致
    const actualName = path.basename(filePath, path.extname(filePath));
    const createdAtIso = new Date().toISOString();
    fs.writeFileSync(filePath, serializeFile({ ...req, name: actualName }, createdAtIso), 'utf-8');
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { meta, sql } = parseFile(content);
    const name = meta.name ?? path.basename(filePath).replace(/\.sql$/i, '');
    const createdAt = meta.createdAt ? Date.parse(meta.createdAt) || stat.mtimeMs : stat.mtimeMs;
    return {
      filePath,
      name,
      sql,
      connectionId: meta.connectionId,
      tags: meta.tags,
      createdAt,
      updatedAt: stat.mtimeMs,
    };
  }

  /** 按收藏名删除；返回是否真删除了文件。统一走 resolveFavoritePath 精确定位。 */
  removeFavorite(name: string): boolean {
    const filePath = this.resolveFavoritePath(name);
    if (!filePath) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** 按收藏名读取文件内容（供编辑器打开为标签页）；不存在抛错。统一走 resolveFavoritePath 精确定位。 */
  readFavorite(name: string): { filePath: string; content: string } {
    const filePath = this.resolveFavoritePath(name);
    if (!filePath) throw new Error(`收藏不存在: ${name}`);
    return { filePath, content: fs.readFileSync(filePath, 'utf-8') };
  }

  /**
   * 重命名收藏：把源文件改为新名（保留元信息与正文）。
   * - 目标冲突检查统一走 resolveFavoritePath（文件名精确 + meta.name 回扫），
   *   防止产生两个相同 meta.name 的收藏。
   * - 先写新文件再删旧文件；删旧失败时回滚新文件，确保原文件不被破坏。
   * @returns 重命名后的 FavoriteItem
   */
  renameFavorite(name: string, newName: string): FavoriteItem {
    const oldPath = this.resolveFavoritePath(name);
    if (!oldPath) throw new Error(`收藏不存在: ${name}`);
    const newFileName = toFileName(newName);
    const newPath = path.join(this.dir, newFileName);
    // 目标逻辑名（精确文件名或 meta.name）已被其它收藏占用 → 拒绝，避免覆盖
    const conflictPath = this.resolveFavoritePath(newName);
    if (conflictPath && conflictPath !== oldPath) {
      throw new Error(`收藏名已存在: ${newName}`);
    }
    if (fs.existsSync(newPath) && newPath !== oldPath) {
      throw new Error(`收藏名已存在: ${newName}`);
    }
    const content = fs.readFileSync(oldPath, 'utf-8');
    const { meta, sql } = parseFile(content);
    // 更新注释块 name（保留其它元信息）
    const blocks: string[] = [];
    blocks.push(`${HEADER_PREFIX}name: ${newName}`);
    if (meta.connectionId) blocks.push(`${HEADER_PREFIX}connection: ${meta.connectionId}`);
    if (meta.tags && meta.tags.length > 0) blocks.push(`${HEADER_PREFIX}tags: ${meta.tags.join(', ')}`);
    if (meta.createdAt) blocks.push(`${HEADER_PREFIX}createdAt: ${meta.createdAt}`);
    const newContent = `${blocks.join('\n')}\n\n${sql.replace(/\s*$/, '')}\n`;
    // 先写新文件；成功后删除旧文件。删旧失败时回滚新文件，保证不产生半成品且原文件完好。
    fs.writeFileSync(newPath, newContent, 'utf-8');
    if (newPath !== oldPath) {
      try {
        fs.unlinkSync(oldPath);
      } catch (err) {
        try { fs.unlinkSync(newPath); } catch { /* 回滚失败尽力而为 */ }
        throw err;
      }
    }
    const stat = fs.statSync(newPath);
    return {
      filePath: newPath,
      name: newName,
      sql,
      connectionId: meta.connectionId,
      tags: meta.tags,
      createdAt: meta.createdAt ? Date.parse(meta.createdAt) || stat.mtimeMs : stat.mtimeMs,
      updatedAt: stat.mtimeMs,
    };
  }

  /**
   * 按收藏名定位文件路径（兼容文件名精确匹配与 meta.name 回扫两种规则）；
   * 找到返回绝对路径，找不到返回 null。保存/读取/删除/重命名统一使用，
   * 保证四者定位规则一致。
   */
  private resolveFavoritePath(name: string): string | null {
    const exactPath = path.join(this.dir, toFileName(name));
    if (fs.existsSync(exactPath)) return exactPath;
    if (!fs.existsSync(this.dir)) return null;
    const files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.sql'));
    for (const f of files) {
      const filePath = path.join(this.dir, f);
      if (filePath === exactPath) continue;
      try {
        const { meta } = parseFile(fs.readFileSync(filePath, 'utf-8'));
        if (meta.name === name) return filePath;
      } catch {
        // 解析失败跳过
      }
    }
    return null;
  }
}
