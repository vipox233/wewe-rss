import { ConfigService } from '@nestjs/config';
import type { Account } from '@prisma/client';
import { AccountProviderRegistry } from '@server/account-providers/account-provider.registry';
import { accountProviderTypes } from '@server/account-providers/account-provider.types';
import { PrismaService } from '@server/prisma/prisma.service';
import { TrpcService } from './trpc.service';

describe('TrpcService account provider routing', () => {
  const account = {
    id: 'local:1',
    provider: accountProviderTypes.LOCAL,
    status: 1,
  } as Account;
  const localProvider = {
    getMpInfo: jest.fn(),
    listMps: jest.fn(),
  };
  const prisma = {
    account: {
      findMany: jest.fn().mockResolvedValue([account]),
    },
  };
  const config = {
    get: jest.fn().mockReturnValue({ updateDelayTime: 60 }),
  };
  const registry = {
    defaultType: accountProviderTypes.LOCAL,
    get: jest.fn().mockReturnValue(localProvider),
  };

  let service: TrpcService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.account.findMany.mockResolvedValue([account]);
    registry.get.mockReturnValue(localProvider);
    service = new TrpcService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      registry as unknown as AccountProviderRegistry,
    );
  });

  it('resolves a share link with the configured local provider', async () => {
    const info = [
      {
        id: 'MP_WXS_1',
        name: '测试公众号',
        cover: '',
        intro: '',
        updateTime: 0,
      },
    ];
    localProvider.getMpInfo.mockResolvedValue(info);

    await expect(
      service.getMpInfo(' https://mp.weixin.qq.com/s/article-id '),
    ).resolves.toEqual(info);
    expect(registry.get).toHaveBeenCalledWith(accountProviderTypes.LOCAL);
    expect(localProvider.getMpInfo).toHaveBeenCalledWith(
      account,
      'https://mp.weixin.qq.com/s/article-id',
    );
  });

  it('lists public accounts through the configured local provider', async () => {
    localProvider.listMps.mockResolvedValue([]);

    await expect(service.listMps()).resolves.toEqual([]);
    expect(registry.get).toHaveBeenCalledWith(accountProviderTypes.LOCAL);
    expect(localProvider.listMps).toHaveBeenCalledWith(account);
  });

  it('exposes local shelf-import capability to the web client', () => {
    expect(service.getAccountProviderInfo()).toEqual({
      type: accountProviderTypes.LOCAL,
      canListMps: true,
    });
  });
});
