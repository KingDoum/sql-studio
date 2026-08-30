/**
 * script-store.ts 单测（任务 6）。
 * mock FsLike，覆盖读写、存在检查、默认文件名推断。
 */
import { describe, it, expect } from 'vitest';
import fs_real from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptStore, type FsLike } from '@main/services/script-store';

function memFs(): { fs: FsLike; data: Record<string, string> } {
  const data: Record<string, string> = {};
  const fsLike: FsLike = {
    existsSync: (p) => p in data,
    readFileSync: (p) => {
      if (!(p in data)) throw new Error(`ENOENT: ${p}`);
      return data[p];
    },
    writeFileSync: (p, content) => {
      data[p] = content;
    },
    mkdirSync: () => {
      /* mem fs 视为已存在/自动创建 */
    },
  };
  return { fs: fsLike, data };
}

describe('ScriptStore', () => {
  it('write 后 read 往返', () => {
    const { fs } = memFs();
    const store = new ScriptStore(fs);
    store.write('C:/x/a.sql', 'SELECT 1');
    expect(store.read('C:/x/a.sql')).toBe('SELECT 1');
    expect(store.exists('C:/x/a.sql')).toBe(true);
  });

  it('read 不存在抛错', () => {
    const { fs } = memFs();
    const store = new ScriptStore(fs);
    expect(() => store.read('C:/nope.sql')).toThrow(/不存在/);
  });

  it('defaultFileName 取首条语句前若干字符', () => {
    const name = ScriptStore.defaultFileName('-- 注释\nSELECT user_id FROM t');
    expect(name).toMatch(/^SELECT_user_id_FROM_t\.sql$/);
  });

  it('defaultFileName 空内容回退 untitled', () => {
    expect(ScriptStore.defaultFileName('   \n  ')).toBe('untitled.sql');
  });
});

describe('路径边界（S6）', () => {
  it('非 ASCII 文件名与内容可读写', () => {
    const { fs } = memFs();
    const store = new ScriptStore(fs);
    store.write('C:/数据/月度报表.sql', 'SELECT 中文内容');
    expect(store.read('C:/数据/月度报表.sql')).toBe('SELECT 中文内容');
  });

  it('Windows 盘符路径被原样处理（不转义、不截断）', () => {
    const { fs } = memFs();
    const store = new ScriptStore(fs);
    const p = 'D:\\工作区\\scripts\\my query.sql';
    store.write(p, 'SELECT 1');
    expect(store.exists(p)).toBe(true);
    expect(store.read(p)).toBe('SELECT 1');
  });

  it('UNC 路径（\\\\server\\share）可读写', () => {
    const { fs } = memFs();
    const store = new ScriptStore(fs);
    const p = '\\\\nas\\share\\backup\\a.sql';
    store.write(p, 'SELECT 2');
    expect(store.read(p)).toBe('SELECT 2');
  });

  it('不存在路径的 read 抛错（用户得到可读反馈）', () => {
    const { fs } = memFs();
    const store = new ScriptStore(fs);
    expect(() => store.read('Z:/no/such/file.sql')).toThrow(/不存在/);
  });

  it('父目录不存在时 write 自动创建目录', () => {
    const tmp = fs_real.mkdtempSync(path.join(os.tmpdir(), 'script-store-'));
    try {
      const store = new ScriptStore();
      const nested = path.join(tmp, 'a', 'b', 'c.sql');
      store.write(nested, 'SELECT 1');
      expect(store.exists(nested)).toBe(true);
    } finally {
      fs_real.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
