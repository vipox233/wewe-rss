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
    feedSchedule: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
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
    prisma.feedSchedule.findUnique.mockResolvedValue(null);
    prisma.feedSchedule.upsert.mockResolvedValue({
      id: 1,
      enabled: true,
      intervalMinutes: 720,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: new Date(Date.now() + 720 * 60 * 1000),
      lastError: null,
    });
    prisma.feedSchedule.update.mockResolvedValue({
      id: 1,
      enabled: true,
      intervalMinutes: 720,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: new Date(Date.now() + 720 * 60 * 1000),
      lastError: null,
    });
    registry.get.mockReturnValue(localProvider);
    service = new TrpcService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      registry as unknown as AccountProviderRegistry,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
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
    expect(localProvider.listMps).toHaveBeenCalledWith(account, {
      forceRefresh: true,
    });
  });

  it('exposes local shelf-import capability to the web client', () => {
    expect(service.getAccountProviderInfo()).toEqual({
      type: accountProviderTypes.LOCAL,
      canListMps: true,
    });
  });

  it('creates a persistent 12-hour feed schedule by default', async () => {
    await service.onModuleInit();

    expect(prisma.feedSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          id: 1,
          enabled: true,
          intervalMinutes: 720,
          nextRunAt: expect.any(Date),
        }),
      }),
    );
  });

  it('updates the feed schedule and exposes its status', async () => {
    const persisted = {
      id: 1,
      enabled: true,
      intervalMinutes: 360,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: new Date(Date.now() + 360 * 60 * 1000),
      lastError: null,
    };
    prisma.feedSchedule.upsert.mockResolvedValue(persisted);
    prisma.feedSchedule.findUnique.mockResolvedValue(persisted);

    await expect(service.updateFeedSchedule(true, 360)).resolves.toEqual({
      ...persisted,
      isRunning: false,
    });
    await expect(service.getFeedSchedule()).resolves.toEqual({
      ...persisted,
      isRunning: false,
    });
    expect(prisma.feedSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          enabled: true,
          intervalMinutes: 360,
          nextRunAt: expect.any(Date),
        }),
      }),
    );
  });

  it('re-arms the scheduler after the first status write fails', async () => {
    const persisted = {
      id: 1,
      enabled: true,
      intervalMinutes: 720,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: new Date(Date.now() + 720 * 60 * 1000),
      lastError: null,
    };
    prisma.feedSchedule.update
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockResolvedValue(persisted);
    prisma.feedSchedule.findUnique.mockResolvedValue(persisted);
    const armSpy = jest
      .spyOn(service as any, 'armFeedSchedule')
      .mockResolvedValue(undefined);

    await (service as any).runScheduledFeedUpdate();

    expect(armSpy).toHaveBeenCalledWith(persisted);
    expect(prisma.feedSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nextRunAt: expect.any(Date) } }),
    );
  });

  it('starts a recovery timer when the database stays unavailable', async () => {
    prisma.feedSchedule.update.mockRejectedValue(new Error('database down'));
    prisma.feedSchedule.findUnique.mockRejectedValue(
      new Error('database down'),
    );
    const recoverySpy = jest
      .spyOn(service as any, 'armFeedScheduleRecovery')
      .mockImplementation(() => undefined);

    await (service as any).runScheduledFeedUpdate();

    expect(recoverySpy).toHaveBeenCalledTimes(1);
  });
});
