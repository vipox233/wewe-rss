import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { ConfigurationType } from '@server/configuration';
import { defaultCount, statusMap } from '@server/constants';
import { PrismaService } from '@server/prisma/prisma.service';
import { TRPCError, initTRPC } from '@trpc/server';
import { AccountProviderRegistry } from '@server/account-providers/account-provider.registry';
import {
  AccountProviderError,
  AccountProviderType,
  accountProviderTypes,
} from '@server/account-providers/account-provider.types';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { reconcileArticles } from './article-reconciliation';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 读书账号每日小黑屋
 */
const blockedAccountsMap = new Map<string, string[]>();

@Injectable()
export class TrpcService implements OnModuleInit, OnModuleDestroy {
  trpc = initTRPC.create();
  publicProcedure = this.trpc.procedure;
  protectedProcedure = this.trpc.procedure.use(({ ctx, next }) => {
    const errorMsg = (ctx as any).errorMsg;
    if (errorMsg) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: errorMsg });
    }
    return next({ ctx });
  });
  router = this.trpc.router;
  mergeRouters = this.trpc.mergeRouters;
  updateDelayTime = 60;

  private readonly logger = new Logger(this.constructor.name);
  private readonly feedScheduleId = 1;
  private readonly defaultFeedIntervalMinutes = 12 * 60;
  private readonly feedScheduleRecoveryDelayMs = 60 * 1000;
  private feedScheduleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly accountProviders: AccountProviderRegistry,
  ) {
    this.updateDelayTime =
      this.configService.get<ConfigurationType['feed']>(
        'feed',
      )!.updateDelayTime;
  }

  async onModuleInit() {
    try {
      const schedule = await this.ensureFeedSchedule();
      await this.armFeedSchedule(schedule);
    } catch (error) {
      this.logger.error('初始化公众号自动更新任务失败', error);
      this.armFeedScheduleRecovery();
    }
  }

  onModuleDestroy() {
    if (this.feedScheduleTimer) clearTimeout(this.feedScheduleTimer);
  }

  removeBlockedAccount = (vid: string) => {
    const today = this.getTodayDate();

    const blockedAccounts = blockedAccountsMap.get(today);
    if (Array.isArray(blockedAccounts)) {
      const newBlockedAccounts = blockedAccounts.filter((id) => id !== vid);
      blockedAccountsMap.set(today, newBlockedAccounts);
    }
  };

  private getTodayDate() {
    return dayjs.tz(new Date(), 'Asia/Shanghai').format('YYYY-MM-DD');
  }

  getBlockedAccountIds() {
    const today = this.getTodayDate();
    const disabledAccounts = blockedAccountsMap.get(today) || [];
    this.logger.debug('disabledAccounts: ', disabledAccounts);
    return disabledAccounts.filter(Boolean);
  }

  private addBlockedAccount(id: string) {
    const today = this.getTodayDate();
    const accounts = blockedAccountsMap.get(today) || [];
    if (!accounts.includes(id)) accounts.push(id);
    blockedAccountsMap.set(today, accounts);
  }

  private async getAvailableAccount(
    provider: AccountProviderType = this.accountProviders.defaultType,
  ) {
    const disabledAccounts = this.getBlockedAccountIds();
    const account = await this.prismaService.account.findMany({
      where: {
        status: statusMap.ENABLE,
        provider,
        NOT: {
          id: { in: disabledAccounts },
        },
      },
      take: 10,
    });

    if (!account || account.length === 0) {
      throw new Error(`暂无可用的 ${provider} 读书账号!`);
    }

    return account[Math.floor(Math.random() * account.length)];
  }

  async getMpArticles(mpId: string, page = 1, retryCount = 3) {
    const account = await this.getAvailableAccount();
    const provider = this.accountProviders.get(account.provider);

    try {
      const res = await provider.getMpArticles(account, mpId, page);
      this.logger.log(
        `getMpArticles(${mpId}) provider: ${provider.type} page: ${page} articles: ${res.length}`,
      );
      return res;
    } catch (err) {
      await this.handleAccountProviderError(account.id, err);
      this.logger.error(`retry(${4 - retryCount}) getMpArticles  error: `, err);
      if (retryCount > 0) {
        return this.getMpArticles(mpId, page, retryCount - 1);
      } else {
        throw err;
      }
    }
  }

  async refreshMpArticlesAndUpdateFeed(
    mpId: string,
    page = 1,
    options: { updateHistoryState?: boolean } = {},
  ) {
    const articles = await this.getMpArticles(mpId, page);
    const latestOnly = articles.some((article) => article.source === 'cover');

    if (articles.length > 0) {
      const existing = await this.prismaService.article.findMany({
        where: {
          mpId,
          OR: [
            { id: { in: articles.map(({ id }) => id) } },
            { title: { in: articles.map(({ title }) => title) } },
          ],
        },
        select: {
          id: true,
          mpId: true,
          title: true,
          picUrl: true,
          publishTime: true,
          publishTimeEstimated: true,
          createdAt: true,
        },
      });
      const reconciled = reconcileArticles(mpId, articles, existing);
      const operations: Prisma.PrismaPromise<unknown>[] = [];
      if (reconciled.deleteIds.length > 0) {
        operations.push(
          this.prismaService.article.deleteMany({
            where: { id: { in: reconciled.deleteIds }, mpId },
          }),
        );
      }
      operations.push(
        ...reconciled.articles.map((article) =>
          this.prismaService.article.upsert({
            create: article,
            update: {
              picUrl: article.picUrl,
              publishTime: article.publishTime,
              publishTimeEstimated: article.publishTimeEstimated,
              title: article.title,
            },
            where: { id: article.id },
          }),
        ),
      );
      const results = await this.prismaService.$transaction(operations);

      this.logger.debug(
        `refreshMpArticlesAndUpdateFeed results: ${JSON.stringify(results)}; removed aliases: ${reconciled.deleteIds.join(',')}`,
      );
    }

    // 普通刷新返回几篇文章，不能说明历史是否已经取完。
    // 只有显式历史分页且未降级为 cover 时，才更新 hasHistory。
    const hasHistory = latestOnly ? 1 : articles.length < defaultCount ? 0 : 1;
    const updateHistoryState = options.updateHistoryState && !latestOnly;

    await this.prismaService.feed.update({
      where: { id: mpId },
      data: {
        syncTime: Math.floor(Date.now() / 1e3),
        ...(updateHistoryState || latestOnly ? { hasHistory } : {}),
      },
    });

    return { hasHistory, historyUnavailable: latestOnly };
  }

  inProgressHistoryMp = {
    id: '',
    page: 1,
  };

  async getHistoryMpArticles(mpId: string) {
    if (this.inProgressHistoryMp.id === mpId) {
      this.logger.log(`getHistoryMpArticles(${mpId}) is running`);
      return;
    }

    this.inProgressHistoryMp = {
      id: mpId,
      page: 1,
    };

    if (!this.inProgressHistoryMp.id) {
      return;
    }

    try {
      const feed = await this.prismaService.feed.findFirstOrThrow({
        where: {
          id: mpId,
        },
      });

      // 如果完整同步过历史文章，则直接返回
      if (feed.hasHistory === 0) {
        this.logger.log(`getHistoryMpArticles(${mpId}) has no history`);
        return;
      }

      const total = await this.prismaService.article.count({
        where: {
          mpId,
        },
      });
      this.inProgressHistoryMp.page = Math.max(
        1,
        Math.ceil(total / defaultCount),
      );

      // 最多尝试一千次
      let i = 1e3;
      while (i-- > 0) {
        if (this.inProgressHistoryMp.id !== mpId) {
          this.logger.log(
            `getHistoryMpArticles(${mpId}) is not running, break`,
          );
          break;
        }
        const { hasHistory, historyUnavailable } =
          await this.refreshMpArticlesAndUpdateFeed(
            mpId,
            this.inProgressHistoryMp.page,
            { updateHistoryState: true },
          );
        if (historyUnavailable) {
          this.logger.warn(
            `getHistoryMpArticles(${mpId}) 当前只能获取最新文章，保留历史入口以便稍后重试`,
          );
          break;
        }
        if (hasHistory < 1) {
          this.logger.log(
            `getHistoryMpArticles(${mpId}) has no history, break`,
          );
          break;
        }
        this.inProgressHistoryMp.page++;

        await new Promise((resolve) =>
          setTimeout(resolve, this.updateDelayTime * 1e3),
        );
      }
    } finally {
      this.inProgressHistoryMp = {
        id: '',
        page: 1,
      };
    }
  }

  isRefreshAllMpArticlesRunning = false;

  async refreshAllMpArticlesAndUpdateFeed(onlyEnabled = false) {
    if (this.isRefreshAllMpArticlesRunning) {
      this.logger.log('refreshAllMpArticlesAndUpdateFeed is running');
      return;
    }
    const mps = await this.prismaService.feed.findMany({
      where: onlyEnabled ? { status: statusMap.ENABLE } : undefined,
    });
    this.isRefreshAllMpArticlesRunning = true;
    const failures: string[] = [];
    try {
      for (const [index, { id }] of mps.entries()) {
        try {
          await this.refreshMpArticlesAndUpdateFeed(id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push(`${id}: ${message}`);
          this.logger.error(`更新公众号（${id}）失败：${message}`);
        }

        if (index < mps.length - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.updateDelayTime * 1e3),
          );
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} 个公众号更新失败；${failures.slice(0, 3).join('；')}`,
        );
      }
    } finally {
      this.isRefreshAllMpArticlesRunning = false;
    }
  }

  async getFeedSchedule() {
    const schedule = await this.ensureFeedSchedule();
    return {
      ...schedule,
      isRunning: this.isRefreshAllMpArticlesRunning,
    };
  }

  async updateFeedSchedule(enabled: boolean, intervalMinutes: number) {
    const nextRunAt = enabled
      ? new Date(Date.now() + intervalMinutes * 60 * 1000)
      : null;
    const schedule = await this.prismaService.feedSchedule.upsert({
      where: { id: this.feedScheduleId },
      create: {
        id: this.feedScheduleId,
        enabled,
        intervalMinutes,
        nextRunAt,
      },
      update: { enabled, intervalMinutes, nextRunAt },
    });
    await this.armFeedSchedule(schedule);
    return {
      ...schedule,
      isRunning: this.isRefreshAllMpArticlesRunning,
    };
  }

  private async ensureFeedSchedule() {
    const existing = await this.prismaService.feedSchedule.findUnique({
      where: { id: this.feedScheduleId },
    });
    if (existing) return existing;

    const nextRunAt = new Date(
      Date.now() + this.defaultFeedIntervalMinutes * 60 * 1000,
    );
    return this.prismaService.feedSchedule.upsert({
      where: { id: this.feedScheduleId },
      create: {
        id: this.feedScheduleId,
        enabled: true,
        intervalMinutes: this.defaultFeedIntervalMinutes,
        nextRunAt,
      },
      update: {},
    });
  }

  private async armFeedSchedule(schedule: {
    enabled: boolean;
    intervalMinutes: number;
    nextRunAt: Date | null;
  }) {
    if (this.feedScheduleTimer) clearTimeout(this.feedScheduleTimer);
    this.feedScheduleTimer = undefined;
    if (!schedule.enabled) return;

    let nextRunAt = schedule.nextRunAt;
    if (!nextRunAt || nextRunAt.getTime() <= Date.now()) {
      nextRunAt = new Date(Date.now() + 5 * 1000);
      await this.prismaService.feedSchedule.update({
        where: { id: this.feedScheduleId },
        data: { nextRunAt },
      });
    }
    const delay = Math.max(1000, nextRunAt.getTime() - Date.now());
    this.feedScheduleTimer = setTimeout(() => {
      void this.runScheduledFeedUpdate();
    }, delay);
    this.feedScheduleTimer.unref?.();
  }

  private async runScheduledFeedUpdate() {
    const startedAt = new Date();
    try {
      await this.prismaService.feedSchedule.update({
        where: { id: this.feedScheduleId },
        data: { lastRunAt: startedAt, nextRunAt: null, lastError: null },
      });
      if (this.isRefreshAllMpArticlesRunning) {
        throw new Error('已有公众号更新任务正在运行，本次自动更新已跳过');
      }
      await this.refreshAllMpArticlesAndUpdateFeed(true);
      await this.prismaService.feedSchedule.update({
        where: { id: this.feedScheduleId },
        data: { lastSuccessAt: new Date(), lastError: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`公众号自动更新失败：${message}`);
      try {
        await this.prismaService.feedSchedule.update({
          where: { id: this.feedScheduleId },
          data: { lastError: message },
        });
      } catch (recordError) {
        this.logger.error(
          '记录公众号自动更新失败状态时数据库不可用',
          recordError,
        );
      }
    } finally {
      await this.rescheduleFeedUpdate();
    }
  }

  private async rescheduleFeedUpdate() {
    try {
      const current = await this.ensureFeedSchedule();
      const nextRunAt = current.enabled
        ? new Date(Date.now() + current.intervalMinutes * 60 * 1000)
        : null;
      const schedule = await this.prismaService.feedSchedule.update({
        where: { id: this.feedScheduleId },
        data: { nextRunAt },
      });
      await this.armFeedSchedule(schedule);
    } catch (error) {
      this.logger.error('重新安排公众号自动更新任务失败，将在稍后重试', error);
      this.armFeedScheduleRecovery();
    }
  }

  private armFeedScheduleRecovery() {
    if (this.feedScheduleTimer) clearTimeout(this.feedScheduleTimer);
    this.feedScheduleTimer = setTimeout(() => {
      void this.recoverFeedSchedule();
    }, this.feedScheduleRecoveryDelayMs);
    this.feedScheduleTimer.unref?.();
  }

  private async recoverFeedSchedule() {
    try {
      const schedule = await this.ensureFeedSchedule();
      await this.armFeedSchedule(schedule);
    } catch (error) {
      this.logger.error('恢复公众号自动更新任务失败，将继续重试', error);
      this.armFeedScheduleRecovery();
    }
  }

  async getMpInfo(url: string) {
    url = url.trim();
    const account = await this.getAvailableAccount();
    return this.accountProviders.get(account.provider).getMpInfo(account, url);
  }

  async listMps() {
    const account = await this.getAvailableAccount();
    const provider = this.accountProviders.get(account.provider);
    if (!provider.listMps) {
      throw new Error('当前账号提供器不支持读取微信读书已关注列表');
    }
    return provider.listMps(account, { forceRefresh: true });
  }

  getAccountProviderInfo() {
    const type = this.accountProviders.defaultType;
    return {
      type,
      canListMps: type === accountProviderTypes.LOCAL,
    };
  }

  async createLoginUrl() {
    return this.accountProviders.getDefault().createLoginUrl();
  }

  async getLoginResult(id: string, otp?: string) {
    return this.accountProviders.getDefault().getLoginResult(id, otp);
  }

  async renewLocalAccount(id: string) {
    const account = await this.prismaService.account.findUnique({
      where: { id },
      select: { provider: true },
    });
    if (!account || account.provider !== accountProviderTypes.LOCAL) {
      throw new Error('只能手动续期本地微信读书账号');
    }
    await this.accountProviders.renewLocalAccount(id);
    this.removeBlockedAccount(id);
    return { success: true };
  }

  private async handleAccountProviderError(accountId: string, error: unknown) {
    if (!(error instanceof AccountProviderError)) return;
    if (error.kind === 'auth') {
      await this.prismaService.account.update({
        where: { id: accountId },
        data: { status: statusMap.INVALID },
      });
      this.logger.error(`账号（${accountId}）续期及重试均失败，已标记失效`);
      return;
    }
    if (error.kind === 'rate_limit') {
      this.addBlockedAccount(accountId);
      this.logger.error(`账号（${accountId}）请求频繁，已进入今日小黑屋`);
      return;
    }
    if (error.kind === 'bad_request') {
      await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
    }
  }
}
