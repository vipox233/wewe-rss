import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Account } from '@prisma/client';
import { ConfigurationType } from '@server/configuration';
import { defaultCount, statusMap } from '@server/constants';
import { PrismaService } from '@server/prisma/prisma.service';
import Axios, { AxiosInstance, AxiosResponse } from 'axios';
import { load } from 'cheerio';
import {
  AccountProvider,
  AccountProviderError,
  LoginResult,
  LoginUrlResult,
  MpArticle,
  MpInfo,
  accountProviderTypes,
} from './account-provider.types';
import {
  CookieJar,
  SessionCodec,
  WeReadSessionState,
  mergeSetCookie,
  toCookieHeader,
} from './weread-session';
import {
  ArticleListPayload,
  mapMpCoverArticle,
  parseMpArticleGroups,
} from './weread-articles';

type PendingLogin = {
  cookies: CookieJar;
  createdAt: number;
};

type CachedMpList = {
  expiresAt: number;
  items: MpInfo[];
};

const userAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

@Injectable()
export class LocalWeReadProvider implements AccountProvider {
  readonly type = accountProviderTypes.LOCAL;

  private readonly logger = new Logger(this.constructor.name);
  private readonly request: AxiosInstance;
  private readonly publicRequest: AxiosInstance;
  private readonly codec: SessionCodec;
  private readonly renewIntervalMs: number;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly renewInFlight = new Map<
    string,
    Promise<WeReadSessionState>
  >();
  private readonly mpListCache = new Map<string, CachedMpList>();

  constructor(
    private readonly prismaService: PrismaService,
    configService: ConfigService,
  ) {
    const config = configService.get<ConfigurationType['weread']>('weread')!;
    this.request = Axios.create({
      baseURL: config.baseUrl,
      timeout: 20 * 1000,
      maxRedirects: 5,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': userAgent,
      },
      validateStatus: () => true,
    });
    this.publicRequest = Axios.create({
      timeout: 15 * 1000,
      maxRedirects: 0,
      maxContentLength: 4 * 1024 * 1024,
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': userAgent,
      },
      responseType: 'text',
      validateStatus: () => true,
    });
    this.renewIntervalMs = config.renewIntervalHours * 60 * 60 * 1000;
    this.codec = new SessionCodec(config.sessionSecret);

    if (!this.codec.isEncrypted()) {
      this.logger.warn(
        '未配置 WEREAD_SESSION_SECRET，本地微信读书会话将按明文编码保存',
      );
    }
  }

  async createLoginUrl(): Promise<LoginUrlResult> {
    this.removeExpiredLogins();
    let cookies: CookieJar = {};

    const pageResponse = await this.request.get('/r/weread-skills', {
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${this.request.defaults.baseURL}/`,
      },
      responseType: 'text',
    });
    this.ensureHttpSuccess(pageResponse, '打开微信读书登录页');
    cookies = this.captureCookies(cookies, pageResponse);

    const uidResponse = await this.request.get('/api/auth/getLoginUid', {
      headers: {
        Cookie: toCookieHeader(cookies),
        Referer: `${this.request.defaults.baseURL}/r/weread-skills`,
      },
    });
    this.ensureHttpSuccess(uidResponse, '获取微信读书登录二维码');
    cookies = this.captureCookies(cookies, uidResponse);
    const body = this.unwrapData(uidResponse.data);
    const uid = typeof body?.uid === 'string' ? body.uid : '';
    if (!uid) {
      throw new AccountProviderError(
        'transient',
        '微信读书没有返回有效的登录 UID',
      );
    }

    this.pendingLogins.set(uid, { cookies, createdAt: Date.now() });
    return {
      uuid: uid,
      scanUrl: `${this.request.defaults.baseURL}/web/confirm?uid=${encodeURIComponent(uid)}`,
      provider: this.type,
      expiresIn: 300,
    };
  }

  async getLoginResult(id: string, otp?: string): Promise<LoginResult> {
    const pending = this.pendingLogins.get(id);
    if (!pending) {
      return {
        provider: this.type,
        message: '二维码已过期，请重新生成',
      };
    }
    if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
      this.pendingLogins.delete(id);
      return {
        provider: this.type,
        message: '二维码已过期，请重新生成',
      };
    }

    let response: AxiosResponse;
    try {
      response = await this.request.get('/api/auth/getLoginInfo', {
        params: { uid: id, otp: otp || '' },
        timeout: 75 * 1000,
        headers: {
          Cookie: toCookieHeader(pending.cookies),
          Referer: `${this.request.defaults.baseURL}/r/weread-skills`,
        },
      });
    } catch (error: any) {
      if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
        return { provider: this.type, message: '', pending: true };
      }
      throw error;
    }
    this.ensureHttpSuccess(response, '查询扫码登录状态');
    pending.cookies = this.captureCookies(pending.cookies, response);

    const result = this.unwrapData(response.data);
    if (result?.succeed === true || Number(result?.succeed) === 1) {
      const completed = await this.completeLogin(result, pending.cookies);
      this.pendingLogins.delete(id);
      return completed;
    }

    const logicCode = String(result?.logicCode ?? '');
    if (logicCode === 'NEED_OTP' || logicCode === 'OTP_NOT_MATCH') {
      return {
        provider: this.type,
        message: logicCode === 'OTP_NOT_MATCH' ? '验证码不正确' : '',
        needOtp: true,
      };
    }
    if (logicCode === 'OTP_EXPIRED') {
      return {
        provider: this.type,
        message: '验证码已过期，请重新扫码',
      };
    }

    // getLoginInfo 在等待扫码时也可能返回 LOGIN_TIMEOUT，此时二维码仍有效。
    return { provider: this.type, message: '', pending: true };
  }

  async getMpArticles(account: Account, mpId: string, page: number) {
    let session = await this.loadSession(account.id);
    if (this.isRenewDue(session)) {
      try {
        session = await this.renewSession(account.id, session);
      } catch (error) {
        // 续期接口偶发失败时，先用现有会话请求真实列表；只有两者都失败才上抛。
        this.logger.warn(
          `账号 ${account.id} 请求前续期失败，将使用现有会话验证：${this.asProviderError(error).message}`,
        );
      }
    }

    try {
      return await this.collectArticlePage(account.id, session, mpId, page);
    } catch (error) {
      const providerError = this.asProviderError(error);
      if (
        providerError.kind !== 'auth' &&
        providerError.providerCode !== -2041
      ) {
        throw providerError;
      }

      // -2012 通常是短期 Cookie 过期，-2041 通常是临时 WPA 票据过期。
      session = await this.renewSession(account.id, session, true);
      try {
        return await this.collectArticlePage(account.id, session, mpId, page);
      } catch (retryError) {
        const retryProviderError = this.asProviderError(retryError);
        if (retryProviderError.providerCode === -2041) {
          if (page === 1) {
            this.logger.warn(
              `公众号 ${mpId} 的完整列表接口仍要求 WPA，降级获取最新文章`,
            );
            return this.getLatestArticle(account.id, session, mpId);
          }
          return [];
        }
        throw retryProviderError;
      }
    }
  }

  async getMpInfo(account: Account, url: string): Promise<MpInfo[]> {
    const shareUrl = this.validateShareUrl(url);
    const response = await this.fetchWeChatArticlePage(shareUrl);

    const $ = load(String(response.data || ''));
    const author = this.normalizeMpName(
      $('meta[property="og:article:author"]').attr('content') ||
        $('#js_name').first().text() ||
        $('.rich_media_meta_nickname').first().text() ||
        '',
    );
    if (!author) {
      throw new AccountProviderError(
        'bad_request',
        '未能从分享链接识别公众号，请使用“从微信读书已关注列表导入”',
      );
    }

    const matches = (await this.listMps(account)).filter(
      (item) => this.normalizeMpName(item.name) === author,
    );
    if (matches.length === 1) return matches;
    if (matches.length > 1) {
      throw new AccountProviderError(
        'bad_request',
        `微信读书中有多个名为“${author}”的公众号，请从已关注列表中选择`,
      );
    }
    throw new AccountProviderError(
      'bad_request',
      `微信读书书架中没有“${author}”。请先在微信读书 App 中关注该公众号，再重新加载已关注列表`,
    );
  }

  async listMps(account: Account): Promise<MpInfo[]> {
    const cached = this.mpListCache.get(account.id);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    let session = await this.loadSession(account.id);
    if (this.isRenewDue(session)) {
      try {
        session = await this.renewSession(account.id, session);
      } catch (error) {
        this.logger.warn(
          `账号 ${account.id} 读取书架前续期失败，将使用现有会话验证：${this.asProviderError(error).message}`,
        );
      }
    }

    let items: MpInfo[];
    try {
      items = await this.fetchMpList(account.id, session);
    } catch (error) {
      const providerError = this.asProviderError(error);
      if (providerError.kind !== 'auth') throw providerError;
      session = await this.renewSession(account.id, session, true);
      items = await this.fetchMpList(account.id, session);
    }

    this.mpListCache.set(account.id, {
      items,
      expiresAt: Date.now() + 60 * 1000,
    });
    return items;
  }

  async renewAccount(accountId: string) {
    await this.renewSession(accountId, undefined, true);
  }

  @Cron('17 * * * *', { name: 'renewLocalWeReadSessions' })
  async renewDueAccounts() {
    const cutoff = new Date(Date.now() - this.renewIntervalMs);
    const sessions = await this.prismaService.accountSession.findMany({
      where: {
        account: { provider: this.type, status: statusMap.ENABLE },
        OR: [{ lastRenewAt: null }, { lastRenewAt: { lte: cutoff } }],
      },
      select: { accountId: true },
    });

    for (const { accountId } of sessions) {
      try {
        await this.renewSession(accountId, undefined, true);
      } catch (error) {
        const providerError = this.asProviderError(error);
        await this.prismaService.accountSession.update({
          where: { accountId },
          data: { lastErrorCode: String(providerError.providerCode || '') },
        });
        this.logger.warn(
          `账号 ${accountId} 自动续期失败：${providerError.message}`,
        );
      }
    }
  }

  private async completeLogin(
    result: Record<string, any>,
    loginCookies: CookieJar,
  ): Promise<LoginResult> {
    const vid = String(result.webLoginVid || result.vid || '');
    const accessToken = String(result.accessToken || '');
    const refreshToken = String(result.refreshToken || '');
    if (!vid || !accessToken) {
      throw new AccountProviderError(
        'auth',
        '扫码成功，但微信读书没有返回完整登录凭据',
      );
    }

    let session: WeReadSessionState = {
      cookies: {
        ...loginCookies,
        wr_vid: vid,
        wr_skey: accessToken,
        wr_ql: '0',
        ...(refreshToken ? { wr_rt: encodeURIComponent(refreshToken) } : {}),
      },
    };
    session = await this.performRenewal(session);
    await this.verifySession(session);

    let username = String(result.username || result.name || '');
    if (!username) {
      const userResponse = await this.request.get('/api/userInfo', {
        params: { userVid: vid },
        headers: {
          Cookie: toCookieHeader(session.cookies),
          Referer: `${this.request.defaults.baseURL}/r/weread-skills`,
          'X-Vid': vid,
          'X-Skey': session.cookies.wr_skey || accessToken,
        },
      });
      if (userResponse.status >= 200 && userResponse.status < 300) {
        username = String(this.unwrapData(userResponse.data)?.name || '');
        session.cookies = this.captureCookies(session.cookies, userResponse);
      }
    }
    if (!username) username = `微信读书用户 ${vid}`;

    // 本地账号使用独立主键，避免覆盖同一个 VID 对应的远程平台账号。
    const accountId = `${this.type}:${vid}`;
    const lastRenewAt = new Date(session.lastRenewAt || Date.now());
    await this.prismaService.$transaction([
      this.prismaService.account.upsert({
        where: { id: accountId },
        create: {
          id: accountId,
          token: 'local',
          provider: this.type,
          name: username,
          status: statusMap.ENABLE,
        },
        update: {
          token: 'local',
          provider: this.type,
          name: username,
          status: statusMap.ENABLE,
        },
      }),
      this.prismaService.accountSession.upsert({
        where: { accountId },
        create: {
          accountId,
          data: this.codec.encode(session),
          lastRenewAt,
          nextRenewAt: new Date(lastRenewAt.getTime() + this.renewIntervalMs),
        },
        update: {
          data: this.codec.encode(session),
          lastRenewAt,
          nextRenewAt: new Date(lastRenewAt.getTime() + this.renewIntervalMs),
          lastErrorCode: null,
        },
      }),
    ]);

    return {
      provider: this.type,
      message: '',
      vid,
      username,
    };
  }

  private async loadSession(accountId: string): Promise<WeReadSessionState> {
    const stored = await this.prismaService.accountSession.findUnique({
      where: { accountId },
    });
    if (!stored) {
      throw new AccountProviderError(
        'auth',
        `账号 ${accountId} 没有本地微信读书会话，请重新扫码`,
      );
    }
    try {
      return this.codec.decode(stored.data);
    } catch (error) {
      throw new AccountProviderError(
        'auth',
        `账号 ${accountId} 的本地会话无法解密：${String(error)}`,
      );
    }
  }

  private isRenewDue(session: WeReadSessionState) {
    if (!session.lastRenewAt) return true;
    return (
      Date.now() - new Date(session.lastRenewAt).getTime() >=
      this.renewIntervalMs
    );
  }

  private async renewSession(
    accountId: string,
    current?: WeReadSessionState,
    force = false,
  ): Promise<WeReadSessionState> {
    const existing = this.renewInFlight.get(accountId);
    if (existing) return existing;

    const promise = (async () => {
      const session = current || (await this.loadSession(accountId));
      if (!force && !this.isRenewDue(session)) return session;
      const renewed = await this.performRenewal(session);
      await this.saveSession(accountId, renewed);
      return renewed;
    })();
    this.renewInFlight.set(accountId, promise);
    try {
      return await promise;
    } finally {
      this.renewInFlight.delete(accountId);
    }
  }

  private async performRenewal(
    session: WeReadSessionState,
  ): Promise<WeReadSessionState> {
    if (!session.cookies.wr_rt) {
      throw new AccountProviderError(
        'auth',
        '微信读书会话缺少 wr_rt，无法自动续期',
        -2012,
      );
    }

    const response = await this.request.post(
      '/web/login/renewal',
      { rq: '%2Fweb%2Fbook%2Fread', ql: false },
      {
        headers: {
          Cookie: toCookieHeader(session.cookies),
          Origin: this.request.defaults.baseURL,
          Referer: `${this.request.defaults.baseURL}/`,
          'Content-Type': 'application/json',
        },
      },
    );
    this.ensureHttpSuccess(response, '续期微信读书会话');
    const body = this.unwrapData(response.data);
    if (!(body?.succ === true || Number(body?.succ) === 1)) {
      throw this.responseError(body, '微信读书会话续期失败');
    }

    return {
      ...this.captureResponseAuth(session, response),
      lastRenewAt: new Date().toISOString(),
    };
  }

  private async verifySession(session: WeReadSessionState) {
    const response = await this.request.get('/web/shelf/sync', {
      params: { userVid: '', synckey: 0 },
      headers: this.authHeaders(session),
    });
    this.ensureHttpSuccess(response, '验证微信读书会话');
    const body = this.unwrapData(response.data);
    const code = Number(body?.errCode ?? body?.errcode ?? 0);
    if (code !== 0) throw this.responseError(body, '微信读书会话验证失败');
  }

  private async fetchMpList(
    accountId: string,
    initialSession: WeReadSessionState,
  ): Promise<MpInfo[]> {
    const response = await this.request.get('/web/shelf/sync', {
      params: { userVid: '', synckey: 0, lectureSynckey: 0 },
      headers: this.authHeaders(initialSession),
    });
    this.ensureHttpSuccess(response, '获取微信读书已关注公众号');
    const session = this.captureResponseAuth(initialSession, response);
    const body = this.unwrapData(response.data);
    const code = Number(body?.errCode ?? body?.errcode ?? 0);
    if (code !== 0)
      throw this.responseError(body, '获取微信读书已关注公众号失败');

    const result = new Map<string, MpInfo>();
    const books = Array.isArray(body?.books) ? body.books : [];
    for (const book of books) {
      const id = String(book?.bookId || '');
      if (!id.startsWith('MP_WXS_') || result.has(id)) continue;
      const rawUpdateTime = Number(book?.updateTime || 0);
      result.set(id, {
        id,
        name: String(book?.title || book?.name || id).trim(),
        cover: String(book?.cover || ''),
        intro: String(book?.intro || book?.author || ''),
        updateTime: Number.isFinite(rawUpdateTime)
          ? Math.floor(
              rawUpdateTime > 10_000_000_000
                ? rawUpdateTime / 1000
                : rawUpdateTime,
            )
          : 0,
      });
    }

    if (JSON.stringify(session) !== JSON.stringify(initialSession)) {
      await this.saveSession(accountId, session);
    }
    return [...result.values()];
  }

  private validateShareUrl(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new AccountProviderError('bad_request', '公众号分享链接格式不正确');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'mp.weixin.qq.com' ||
      !parsed.pathname.startsWith('/s/')
    ) {
      throw new AccountProviderError(
        'bad_request',
        '只支持 https://mp.weixin.qq.com/s/ 开头的公众号文章链接',
      );
    }
    return parsed.toString();
  }

  private async fetchWeChatArticlePage(url: string) {
    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
      const response = await this.publicRequest.get<string>(currentUrl);
      if (response.status < 300 || response.status >= 400) {
        this.ensureHttpSuccess(response, '读取公众号文章信息');
        return response;
      }

      const location = String(response.headers.location || '');
      if (!location) {
        throw new AccountProviderError(
          'transient',
          `读取公众号文章信息：HTTP ${response.status} 未返回跳转地址`,
        );
      }
      if (redirectCount === 3) {
        throw new AccountProviderError(
          'transient',
          '公众号文章跳转次数过多，请使用“从微信读书已关注列表导入”',
        );
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new AccountProviderError(
          'bad_request',
          '公众号文章返回了无效的跳转地址',
        );
      }
      if (
        nextUrl.protocol !== 'https:' ||
        nextUrl.hostname !== 'mp.weixin.qq.com' ||
        nextUrl.port ||
        nextUrl.username ||
        nextUrl.password
      ) {
        throw new AccountProviderError(
          'bad_request',
          '公众号文章跳转到了不受信任的地址，已停止访问',
        );
      }
      this.logger.debug(
        `公众号文章 HTTP ${response.status}，跟随微信域内跳转到 ${nextUrl.pathname}`,
      );
      currentUrl = nextUrl.toString();
    }

    throw new AccountProviderError('transient', '读取公众号文章信息失败');
  }

  private normalizeMpName(name: string) {
    return name.replace(/\s+/g, '').trim();
  }

  private async collectArticlePage(
    accountId: string,
    initialSession: WeReadSessionState,
    mpId: string,
    page: number,
  ): Promise<MpArticle[]> {
    const targetCount = Math.max(1, page) * defaultCount;
    const articles: MpArticle[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let session = initialSession;

    for (let requestCount = 0; requestCount < 30; requestCount++) {
      const response = await this.request.get<ArticleListPayload>(
        '/web/mp/articles',
        {
          params: { bookId: mpId, offset },
          headers: this.authHeaders(session, true),
        },
      );
      this.ensureHttpSuccess(response, '获取公众号文章列表');
      session = this.captureResponseAuth(session, response);
      const payload = this.unwrapData(response.data) as ArticleListPayload;
      const code = Number(payload?.errCode ?? 0);
      if (code !== 0)
        throw this.responseError(payload, '获取公众号文章列表失败');

      const parsed = parseMpArticleGroups(payload, mpId);
      for (const article of parsed.articles) {
        if (seen.has(article.id)) continue;
        seen.add(article.id);
        articles.push(article);
      }

      if (
        articles.length >= targetCount ||
        parsed.clearAll ||
        parsed.groupCount === 0
      ) {
        break;
      }
      if (!parsed.nextOffset) break;
      const nextOffset = parsed.nextOffset;
      if (nextOffset === offset) break;
      offset = nextOffset;
    }

    if (JSON.stringify(session) !== JSON.stringify(initialSession)) {
      await this.saveSession(accountId, session);
    }
    const start = (Math.max(1, page) - 1) * defaultCount;
    return articles.slice(start, start + defaultCount);
  }

  private async getLatestArticle(
    accountId: string,
    initialSession: WeReadSessionState,
    mpId: string,
  ): Promise<MpArticle[]> {
    const response = await this.request.get('/api/mp/cover', {
      params: { bookId: mpId },
      headers: this.authHeaders(initialSession),
    });
    this.ensureHttpSuccess(response, '获取公众号最新文章');
    const session = this.captureResponseAuth(initialSession, response);
    const body = this.unwrapData(response.data);
    const code = Number(body?.errCode ?? body?.errcode ?? 0);
    if (code !== 0) throw this.responseError(body, '获取公众号最新文章失败');
    const article = mapMpCoverArticle(body, mpId);
    if (!article) return [];

    if (JSON.stringify(session) !== JSON.stringify(initialSession)) {
      await this.saveSession(accountId, session);
    }
    return [article];
  }

  private async saveSession(accountId: string, session: WeReadSessionState) {
    const lastRenewAt = session.lastRenewAt
      ? new Date(session.lastRenewAt)
      : undefined;
    await this.prismaService.accountSession.update({
      where: { accountId },
      data: {
        data: this.codec.encode(session),
        lastRenewAt,
        nextRenewAt: lastRenewAt
          ? new Date(lastRenewAt.getTime() + this.renewIntervalMs)
          : undefined,
        lastErrorCode: null,
      },
    });
  }

  private authHeaders(session: WeReadSessionState, includeTicket = false) {
    return {
      Cookie: toCookieHeader(session.cookies),
      Origin: this.request.defaults.baseURL,
      Referer: `${this.request.defaults.baseURL}/`,
      ...(includeTicket && session.ticket
        ? { 'x-wr-ticket': session.ticket }
        : {}),
      ...(includeTicket && session.wrpa ? { 'x-wrpa-0': session.wrpa } : {}),
    };
  }

  private captureCookies(cookies: CookieJar, response: AxiosResponse) {
    return mergeSetCookie(cookies, response.headers['set-cookie']);
  }

  private captureResponseAuth(
    session: WeReadSessionState,
    response: AxiosResponse,
  ): WeReadSessionState {
    return {
      ...session,
      cookies: this.captureCookies(session.cookies, response),
      ticket: String(response.headers['x-wr-ticket'] || session.ticket || ''),
      wrpa: String(response.headers['x-wrpa-0'] || session.wrpa || ''),
    };
  }

  private unwrapData(data: any): any {
    if (
      data &&
      typeof data === 'object' &&
      data.data &&
      typeof data.data === 'object'
    ) {
      return { ...data, ...data.data };
    }
    return data;
  }

  private ensureHttpSuccess(response: AxiosResponse, action: string) {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 401 || response.status === 403) {
      throw new AccountProviderError(
        'auth',
        `${action}：HTTP ${response.status}`,
      );
    }
    if (response.status === 429) {
      throw new AccountProviderError(
        'rate_limit',
        `${action}：HTTP 429`,
        429,
        30 * 60 * 1000,
      );
    }
    throw new AccountProviderError(
      'transient',
      `${action}：HTTP ${response.status}`,
      response.status,
    );
  }

  private responseError(body: any, fallback: string) {
    const rawCode = body?.errCode ?? body?.errcode ?? body?.code;
    const code = rawCode === undefined ? undefined : Number(rawCode);
    const message = String(
      body?.errMsg || body?.errmsg || body?.message || fallback,
    );
    if (code === -2012 || code === -2010 || code === -2013) {
      return new AccountProviderError('auth', message, code);
    }
    if (code === 429 || code === -429) {
      return new AccountProviderError(
        'rate_limit',
        message,
        code,
        30 * 60 * 1000,
      );
    }
    if (code === -2041) {
      return new AccountProviderError('bad_request', message, code);
    }
    return new AccountProviderError('transient', message, code);
  }

  private asProviderError(error: unknown) {
    return error instanceof AccountProviderError
      ? error
      : new AccountProviderError('transient', String(error));
  }

  private removeExpiredLogins() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, login] of this.pendingLogins) {
      if (login.createdAt < cutoff) this.pendingLogins.delete(id);
    }
  }
}
