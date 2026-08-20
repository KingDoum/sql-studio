/**
 * 脚本文件读写（任务 6 main-script-export）。
 *
 * 负责 .sql 脚本文件在用户文件系统的读写：路径解析、UTF-8 读写、存在性检查。
 * 与 favorites-store 不同，这里处理「用户自选路径的脚本」（dialog 选路径），
 * 而 favorites-store 管理 `userData/queries/` 下的命名收藏。
 *
 * 依赖注入：构造时注入 fs 抽象（默认 node:fs），便于单测用临时目录。
 * 注意：文件对话框由 preload/ipc 层处理（Electron dialog 在主进程，但此处只做 IO）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 文件系统抽象（便于 mock / 单测）。 */
export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: BufferEncoding): string;
  writeFileSync(p: string, content: string, enc: BufferEncoding): void;
}

const nodeFs: FsLike = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, content, enc) => fs.writeFileSync(p, content, enc),
};

export class ScriptStore {
  private readonly fsModule: FsLike;

  constructor(fsModule: FsLike = nodeFs) {
    this.fsModule = fsModule;
  }

  /** 读取脚本文件（UTF-8）。不存在抛错。 */
  read(filePath: string): string {
    if (!this.fsModule.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    return this.fsModule.readFileSync(filePath, 'utf-8');
  }

  /** 写入脚本文件（UTF-8）。父目录不存在自动创建。 */
  write(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (dir && !this.fsModule.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.fsModule.writeFileSync(filePath, content, 'utf-8');
  }

  /** 是否存在。 */
  exists(filePath: string): boolean {
    return this.fsModule.existsSync(filePath);
  }

  /** 由内容推断默认文件名（首条非空语句前若干字符）。 */
  static defaultFileName(content: string): string {
    const firstLine = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('--')) ?? 'untitled';
    const base = firstLine.replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 40) || 'untitled';
    return `${base}.sql`;
  }
}
