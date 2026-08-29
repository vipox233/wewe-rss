import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

export type CookieJar = Record<string, string>;

export type WeReadSessionState = {
  cookies: CookieJar;
  ticket?: string;
  wrpa?: string;
  lastRenewAt?: string;
};

const allowedCookies = new Set(['ptcz', 'RK', 'pgv_pvid']);

export function mergeSetCookie(
  current: CookieJar,
  setCookie?: string | string[],
): CookieJar {
  const merged = { ...current };
  if (!setCookie) return merged;

  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of values) {
    const firstPart = raw.split(';', 1)[0];
    const separator = firstPart.indexOf('=');
    if (separator < 1) continue;

    const name = firstPart.slice(0, separator).trim();
    const value = firstPart.slice(separator + 1).trim();
    if (!name.startsWith('wr_') && !allowedCookies.has(name)) continue;

    if (value) merged[name] = value;
    else delete merged[name];
  }
  return merged;
}

export function toCookieHeader(cookies: CookieJar): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function articleIdFromReviewId(
  reviewId: string,
  bookId: string,
): string {
  const prefix = `${bookId}_`;
  if (reviewId.startsWith(prefix)) return reviewId.slice(prefix.length).trim();
  const separator = reviewId.lastIndexOf('_');
  return (separator >= 0 ? reviewId.slice(separator + 1) : reviewId).trim();
}

export function normalizeWeChatArticleId(articleId: string): string {
  // `~` 既可能出现在 WeRead 的旧别名里，也可能是合法短链字符。
  // 是否属于旧别名必须结合规范文章页与文章元数据判断，不能全局替换。
  return articleId.trim();
}

export function parseWeChatArticleShareUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'mp.weixin.qq.com' ||
    (parsed.pathname !== '/s' && !parsed.pathname.startsWith('/s/')) ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  return parsed;
}

export class SessionCodec {
  private readonly key?: Buffer;

  constructor(secret?: string) {
    if (secret) this.key = createHash('sha256').update(secret).digest();
  }

  isEncrypted() {
    return Boolean(this.key);
  }

  encode(value: WeReadSessionState): string {
    const serialized = JSON.stringify(value);
    if (!this.key) {
      return `plain:v1:${Buffer.from(serialized).toString('base64url')}`;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(serialized, 'utf8'),
      cipher.final(),
    ]);
    return [
      'enc',
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  decode(value: string): WeReadSessionState {
    if (value.startsWith('plain:v1:')) {
      return JSON.parse(
        Buffer.from(value.slice('plain:v1:'.length), 'base64url').toString(
          'utf8',
        ),
      );
    }

    const [prefix, version, iv, tag, encrypted] = value.split(':');
    if (prefix !== 'enc' || version !== 'v1' || !iv || !tag || !encrypted) {
      throw new Error('不支持的微信读书会话格式');
    }
    if (!this.key) throw new Error('缺少 WEREAD_SESSION_SECRET');

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(decrypted);
  }
}
