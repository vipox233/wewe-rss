import { ConfigService } from '@nestjs/config';
import type { Account } from '@prisma/client';
import { AccountProviderError } from './account-provider.types';
import { LocalWeReadProvider } from './local-weread.provider';

describe('LocalWeReadProvider', () => {
  const prisma = {
    accountSession: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    account: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const config = {
    get: jest.fn().mockReturnValue({
      accountProvider: 'local',
      baseUrl: 'https://weread.qq.com',
      renewIntervalHours: 6,
      sessionSecret: 'test-secret',
    }),
  };

  let provider: LocalWeReadProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new LocalWeReadProvider(
      prisma as any,
      config as unknown as ConfigService,
    );
  });

  it('persists rotated Cookie and WPA credentials from renewal', async () => {
    jest.spyOn((provider as any).request, 'post').mockResolvedValue({
      status: 200,
      data: { succ: 1 },
      headers: {
        'set-cookie': ['wr_skey=new-skey; Path=/; HttpOnly'],
        'x-wr-ticket': 'new-ticket',
        'x-wrpa-0': 'new-wrpa',
      },
    });

    const renewed = await (provider as any).performRenewal({
      cookies: { wr_vid: '1', wr_skey: 'old-skey', wr_rt: 'refresh' },
    });

    expect(renewed.cookies.wr_skey).toBe('new-skey');
    expect(renewed.ticket).toBe('new-ticket');
    expect(renewed.wrpa).toBe('new-wrpa');
    expect(renewed.lastRenewAt).toBeTruthy();
  });

  it('renews a stale WPA ticket and falls back to the latest article', async () => {
    const account = {
      id: 'local:1',
      provider: 'local',
    } as Account;
    const session = { cookies: { wr_rt: 'refresh' } };
    const renewed = { ...session, ticket: 'new-ticket' };
    jest.spyOn(provider as any, 'loadSession').mockResolvedValue(session);
    jest.spyOn(provider as any, 'isRenewDue').mockReturnValue(false);
    jest.spyOn(provider as any, 'renewSession').mockResolvedValue(renewed);
    jest
      .spyOn(provider as any, 'collectArticlePage')
      .mockRejectedValue(
        new AccountProviderError('bad_request', 'WPA required', -2041),
      );
    jest
      .spyOn(provider as any, 'getLatestArticle')
      .mockResolvedValue([
        { id: 'article', title: '最新文章', picUrl: '', publishTime: 1 },
      ]);

    await expect(
      provider.getMpArticles(account, 'MP_WXS_1', 1),
    ).resolves.toEqual([
      { id: 'article', title: '最新文章', picUrl: '', publishTime: 1 },
    ]);
    expect((provider as any).renewSession).toHaveBeenCalledWith(
      account.id,
      session,
      true,
    );
  });

  it('keeps using a live session when proactive renewal temporarily fails', async () => {
    const account = {
      id: 'local:1',
      provider: 'local',
    } as Account;
    const session = { cookies: { wr_skey: 'still-live', wr_rt: 'refresh' } };
    const article = {
      id: 'article',
      title: '文章',
      picUrl: '',
      publishTime: 1,
    };
    jest.spyOn(provider as any, 'loadSession').mockResolvedValue(session);
    jest.spyOn(provider as any, 'isRenewDue').mockReturnValue(true);
    jest
      .spyOn(provider as any, 'renewSession')
      .mockRejectedValue(new AccountProviderError('auth', 'renewal failed'));
    jest
      .spyOn(provider as any, 'collectArticlePage')
      .mockResolvedValue([article]);

    await expect(
      provider.getMpArticles(account, 'MP_WXS_1', 1),
    ).resolves.toEqual([article]);
    expect((provider as any).collectArticlePage).toHaveBeenCalledWith(
      account.id,
      session,
      'MP_WXS_1',
      1,
    );
  });

  it('lists only followed public accounts and normalizes shelf fields', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const session = { cookies: { wr_skey: 'live' } };
    jest.spyOn(provider as any, 'loadSession').mockResolvedValue(session);
    jest.spyOn(provider as any, 'isRenewDue').mockReturnValue(false);
    jest.spyOn((provider as any).request, 'get').mockResolvedValue({
      status: 200,
      data: {
        books: [
          {
            bookId: 'normal-book',
            title: '普通书籍',
          },
          {
            bookId: 'MP_WXS_1',
            title: '测试公众号',
            cover: 'https://example.com/cover.jpg',
            intro: '简介',
            updateTime: 1_780_000_000_000,
          },
          {
            bookId: 'MP_WXS_1',
            title: '重复项',
          },
        ],
      },
      headers: {},
    });

    await expect(provider.listMps(account)).resolves.toEqual([
      {
        id: 'MP_WXS_1',
        name: '测试公众号',
        cover: 'https://example.com/cover.jpg',
        intro: '简介',
        updateTime: 1_780_000_000,
      },
    ]);
  });

  it('bypasses the public-account cache for an explicit refresh', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const session = { cookies: { wr_skey: 'live' } };
    const first = {
      id: 'MP_WXS_1',
      name: '旧列表',
      cover: '',
      intro: '',
      updateTime: 0,
    };
    const refreshed = { ...first, id: 'MP_WXS_2', name: '新关注公众号' };
    jest.spyOn(provider as any, 'loadSession').mockResolvedValue(session);
    jest.spyOn(provider as any, 'isRenewDue').mockReturnValue(false);
    const fetchMpList = jest
      .spyOn(provider as any, 'fetchMpList')
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([refreshed]);

    await expect(provider.listMps(account)).resolves.toEqual([first]);
    await expect(
      provider.listMps(account, { forceRefresh: true }),
    ).resolves.toEqual([refreshed]);
    expect(fetchMpList).toHaveBeenCalledTimes(2);
  });

  it('renews and retries when loading the followed public accounts fails auth', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const session = { cookies: { wr_skey: 'expired', wr_rt: 'refresh' } };
    const renewed = { cookies: { wr_skey: 'new', wr_rt: 'refresh' } };
    jest.spyOn(provider as any, 'loadSession').mockResolvedValue(session);
    jest.spyOn(provider as any, 'isRenewDue').mockReturnValue(false);
    jest.spyOn(provider as any, 'renewSession').mockResolvedValue(renewed);
    jest
      .spyOn((provider as any).request, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: { errCode: -2012, errMsg: '登录超时' },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { books: [{ bookId: 'MP_WXS_1', title: '测试公众号' }] },
        headers: {},
      });

    await expect(provider.listMps(account)).resolves.toHaveLength(1);
    expect((provider as any).renewSession).toHaveBeenCalledWith(
      account.id,
      session,
      true,
    );
  });

  it('matches a share link author against the local WeRead shelf', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const item = {
      id: 'MP_WXS_1',
      name: '测试公众号',
      cover: '',
      intro: '',
      updateTime: 0,
    };
    jest.spyOn(provider, 'listMps').mockResolvedValue([item]);
    jest.spyOn((provider as any).publicRequest, 'get').mockResolvedValue({
      status: 200,
      data: '<meta property="og:article:author" content=" 测试 公众号 ">',
      headers: {},
    });

    await expect(
      provider.getMpInfo(account, 'https://mp.weixin.qq.com/s/article-id'),
    ).resolves.toEqual([item]);
  });

  it('accepts a direct WeChat article URL with query parameters', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const item = {
      id: 'MP_WXS_1',
      name: '测试公众号',
      cover: '',
      intro: '',
      updateTime: 0,
    };
    jest.spyOn(provider, 'listMps').mockResolvedValue([item]);
    const publicGet = jest
      .spyOn((provider as any).publicRequest, 'get')
      .mockResolvedValue({
        status: 200,
        data: '<meta property="og:article:author" content="测试公众号">',
        headers: {},
      });
    const url = 'https://mp.weixin.qq.com/s?__biz=MzXXX&mid=123&idx=1&sn=abc';

    await expect(provider.getMpInfo(account, url)).resolves.toEqual([item]);
    expect(publicGet).toHaveBeenCalledWith(url);
  });

  it('follows redirects that stay on the exact WeChat article host', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const item = {
      id: 'MP_WXS_1',
      name: '测试公众号',
      cover: '',
      intro: '',
      updateTime: 0,
    };
    jest.spyOn(provider, 'listMps').mockResolvedValue([item]);
    const publicGet = jest
      .spyOn((provider as any).publicRequest, 'get')
      .mockResolvedValueOnce({
        status: 302,
        data: '',
        headers: { location: '/s?__biz=test' },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: '<meta property="og:article:author" content="测试公众号">',
        headers: {},
      });

    await expect(
      provider.getMpInfo(account, 'https://mp.weixin.qq.com/s/article-id'),
    ).resolves.toEqual([item]);
    expect(publicGet).toHaveBeenNthCalledWith(
      2,
      'https://mp.weixin.qq.com/s?__biz=test',
    );
  });

  it('rejects redirects that leave the exact WeChat article host', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    jest.spyOn((provider as any).publicRequest, 'get').mockResolvedValue({
      status: 302,
      data: '',
      headers: { location: 'https://example.com/redirected' },
    });

    await expect(
      provider.getMpInfo(account, 'https://mp.weixin.qq.com/s/article-id'),
    ).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('rejects share links outside the exact WeChat article host', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    const publicGet = jest.spyOn((provider as any).publicRequest, 'get');

    await expect(
      provider.getMpInfo(
        account,
        'https://mp.weixin.qq.com.attacker.example/s/article-id',
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(publicGet).not.toHaveBeenCalled();
  });

  it.each([
    'https://user@mp.weixin.qq.com/s/article-id',
    'https://mp.weixin.qq.com:444/s/article-id',
  ])(
    'rejects share links with credentials or a custom port: %s',
    async (url) => {
      const account = { id: 'local:1', provider: 'local' } as Account;
      const publicGet = jest.spyOn((provider as any).publicRequest, 'get');

      await expect(provider.getMpInfo(account, url)).rejects.toMatchObject({
        kind: 'bad_request',
      });
      expect(publicGet).not.toHaveBeenCalled();
    },
  );

  it('explains that the public account must be followed in WeRead', async () => {
    const account = { id: 'local:1', provider: 'local' } as Account;
    jest.spyOn(provider, 'listMps').mockResolvedValue([]);
    jest.spyOn((provider as any).publicRequest, 'get').mockResolvedValue({
      status: 200,
      data: '<meta property="og:article:author" content="未关注公众号">',
      headers: {},
    });

    await expect(
      provider.getMpInfo(account, 'https://mp.weixin.qq.com/s/article-id'),
    ).rejects.toThrow('请先在微信读书 App 中关注');
  });
});
