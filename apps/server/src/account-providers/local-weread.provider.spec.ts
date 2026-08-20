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
});
