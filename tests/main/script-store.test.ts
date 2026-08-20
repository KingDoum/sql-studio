/**
 * script-store.ts 单测（任务 6）。
 * mock FsLike，覆盖读写、存在检查、默认文件名推断。
 */
import { describe, it, expect } from 'vitest';
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
