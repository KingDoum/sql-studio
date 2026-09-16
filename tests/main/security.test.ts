/**
 * security.ts 单测（任务 3）。
 * 注入自定义 EncryptFunctions 模拟 safeStorage 可用/不可用两种分支。
 */
import { describe, it, expect } from 'vitest';
import { Security } from '@main/services/security';
import type { EncryptFunctions } from '@main/services/security';

describe('Security - safeStorage 可用分支（真加密）', () => {
  // 用可逆异或模拟"真加密"后端
  const key = 0x5a;
  const xor = (buf: Buffer): Buffer => {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
    return out;
  };
  const mockReal: EncryptFunctions = {
    isAvailable: () => true,
    encrypt: (p: string) => xor(Buffer.from(p, 'utf-8')),
    decrypt: (c: Buffer | string) => xor(Buffer.isBuffer(c) ? c : Buffer.from(c)).toString('utf-8'),
  };

  it('加密后不再是明文', () => {
    const s = new Security(mockReal);
    const cipher = s.encrypt('my-secret-pw');
    expect(cipher).not.toContain('my-secret-pw');
    expect(s.encryptionAvailable).toBe(true);
  });

  it('加密→解密往返一致', () => {
    const s = new Security(mockReal);
    const plain = 'p@ss w/中文与特殊字符!@#';
    expect(s.decrypt(s.encrypt(plain))).toBe(plain);
  });

  it('空字符串可往返', () => {
    const s = new Security(mockReal);
    expect(s.decrypt(s.encrypt(''))).toBe('');
  });
});

describe('Security - 降级分支（base64 混淆，标记非真加密）', () => {
  it('encryptionAvailable 为 false', () => {
    const s = new Security(); // 无 Electron 环境，自动降级
    expect(s.encryptionAvailable).toBe(false);
  });

  it('降级密文以 b64: 前缀标记', () => {
    const s = new Security();
    const cipher = s.encrypt('hello');
    expect(cipher.startsWith('b64:')).toBe(true);
  });

  it('降级加密→解密往返一致（含中文/特殊字符）', () => {
    const s = new Security();
    const plain = 'root_密码!@#';
    expect(s.decrypt(s.encrypt(plain))).toBe(plain);
  });

  it('解密无前缀历史明文不抛错（向前兼容）', () => {
    const s = new Security();
    expect(s.decrypt('plaintext-legacy')).toBe('plaintext-legacy');
  });
});

describe('Security - 历史密文跨环境兼容（b64 / hex / 明文）', () => {
  /** 模拟 safeStorage：只接受 Buffer，收到字符串（历史上误传 b64 文本）会抛错。 */
  const mockReal: EncryptFunctions = {
    isAvailable: () => true,
    encrypt: (p: string) => Buffer.from(p, 'utf-8'),
    decrypt: (c: Buffer | string) => {
      if (!Buffer.isBuffer(c)) throw new Error('safeStorage 只接受 Buffer');
      return c.toString('utf-8');
    },
  };

  it('b64: 降级密文在 safeStorage 可用环境下仍能正确解密（不自作主张交给当前加密器）', () => {
    const s = new Security(mockReal);
    const legacy = 'b64:' + Buffer.from('旧环境的密码', 'utf-8').toString('base64');
    // 历史 bug：走 this.fn.decrypt(text) → safeStorage 收到字符串抛错，密码永久解不开
    expect(s.decrypt(legacy)).toBe('旧环境的密码');
  });

  it('无前缀历史明文原样返回（不交给当前加密器）', () => {
    const s = new Security(mockReal);
    expect(s.decrypt('legacy-plain')).toBe('legacy-plain');
  });

  it('hex: 密文在 safeStorage 不可用时给出明确错误（而非 TypeError）', () => {
    const s = new Security(); // 非 Electron 环境自动降级，isAvailable() === false
    expect(() => s.decrypt('hex:00ff')).toThrow(/系统密钥/);
  });

  it('未知前缀仍抛「不支持」错误（不静默返回错误数据）', () => {
    const s = new Security(mockReal);
    expect(() => s.decrypt('aes:abcd')).toThrow(/不支持的密文格式/);
  });
});
