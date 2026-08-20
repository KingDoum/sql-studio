/**
 * 安全层：密码加解密（架构铁律 R6，密码仅主进程持有）。
 *
 * 优先使用 Electron 的 safeStorage（系统级密钥加密）；
 * 在非 Electron 环境（单测、CI）或 safeStorage 不可用时，降级为 base64 混淆
 * 并在密文前缀标记，避免误以为真加密。
 *
 * 依赖注入设计：加密/解密函数与 available 判断均可在构造时注入，
 * 单测可直接传入 mock 实现，无需真实 Electron 环境。
 */

export interface EncryptFunctions {
  encrypt(plain: string): Buffer | string;
  decrypt(cipher: Buffer | string): string;
  isAvailable(): boolean;
}

/** 降级方案：base64 混淆，非真加密，仅用于无 safeStorage 环境。 */
const FALLBACK_PREFIX = 'b64:';

function fallbackEncrypt(plain: string): string {
  return FALLBACK_PREFIX + Buffer.from(plain, 'utf-8').toString('base64');
}

function fallbackDecrypt(cipher: string): string {
  if (!cipher.startsWith(FALLBACK_PREFIX)) {
    // 已可能是明文（历史遗留），直接返回以便兼容
    return cipher;
  }
  return Buffer.from(cipher.slice(FALLBACK_PREFIX.length), 'base64').toString('utf-8');
}

/**
 * 默认实现：尝试使用 Electron safeStorage。
 * 在 Electron 主进程内 import('electron') 拿到 safeStorage；失败则降级。
 */
function createDefaultEncryptor(): EncryptFunctions {
  try {
    // 仅在 Electron 运行时成功；单测环境会在此抛错并被捕获
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeStorage } = require('electron') as {
      safeStorage: {
        isEncryptionAvailable(): boolean;
        encryptString(plain: string): Buffer;
        decryptString(cipher: Buffer): string;
      };
    };
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return {
        isAvailable: () => true,
        encrypt: (plain: string) => safeStorage.encryptString(plain),
        decrypt: (cipher) =>
          safeStorage.decryptString(cipher as Buffer),
      };
    }
  } catch {
    // 落到降级分支
  }
  return {
    isAvailable: () => false,
    encrypt: fallbackEncrypt,
    decrypt: fallbackDecrypt,
  };
}

export class Security {
  private readonly fn: EncryptFunctions;

  /** 传入自定义加密器便于单测；缺省走 Electron safeStorage → base64 降级。 */
  constructor(fn?: EncryptFunctions) {
    this.fn = fn ?? createDefaultEncryptor();
  }

  /** 是否使用真加密（safeStorage）。 */
  get encryptionAvailable(): boolean {
    return this.fn.isAvailable();
  }

  /** 加密明文密码，返回可落库字符串。 */
  encrypt(plain: string): string {
    const out = this.fn.encrypt(plain);
    if (typeof out === 'string') return out;
    // Buffer → 十六进制存储，解密时还原
    return `hex:${out.toString('hex')}`;
  }

  /** 解密密文密码为明文。 */
  decrypt(cipher: string): string {
    if (cipher.startsWith('hex:')) {
      return this.fn.decrypt(Buffer.from(cipher.slice(4), 'hex'));
    }
    if (cipher.startsWith(FALLBACK_PREFIX) || !cipher.includes(':')) {
      // 降级密文（b64:）或兼容无前缀明文（历史数据）
      return this.fn.decrypt(cipher);
    }
    // 其他前缀（如未来扩展的 aes:）暂不支持
    throw new Error(`不支持的密文格式: ${cipher.slice(0, 8)}...`);
  }
}
