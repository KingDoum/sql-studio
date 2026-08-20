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

/**
 * 文件名安全化：去除对路径有危险的字符，避免目录穿越与非法文件名。
 * 保留中文、字母、数字、空格、点、下划线、连字符；其余替换为下划线。
 */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|]/g, '_') // 文件系统保留字符
    .replace(/\s+/g, ' ') // 折叠多余空白
    .trim();
  return cleaned.length > 0 ? cleaned : '未命名收藏';
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

  /** 按收藏名（或文件名）删除；返回是否真删除了文件。 */
  removeFavorite(name: string): boolean {
    // 1) 精确文件路径（含重名序号后缀，如 "foo (2).sql"）
    const exactPath = path.join(this.dir, toFileName(name));
    if (fs.existsSync(exactPath)) {
      fs.unlinkSync(exactPath);
      return true;
    }
    // 2) 扫描目录按 meta.name 匹配（兼容旧数据 meta.name 为原名的情况）
    if (fs.existsSync(this.dir)) {
      const files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.sql'));
      for (const f of files) {
        const filePath = path.join(this.dir, f);
        try {
          const { meta } = parseFile(fs.readFileSync(filePath, 'utf-8'));
          if (meta.name === name) {
            fs.unlinkSync(filePath);
            return true;
          }
        } catch {
          // 解析失败跳过
        }
      }
    }
    return false;
  }

  /** 按收藏名读取文件内容（供编辑器打开为标签页）；不存在抛错。 */
  readFavorite(name: string): { filePath: string; content: string } {
    const filePath = path.join(this.dir, toFileName(name));
    if (!fs.existsSync(filePath)) {
      throw new Error(`收藏不存在: ${name}`);
    }
    return { filePath, content: fs.readFileSync(filePath, 'utf-8') };
  }
}
