import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Account } from '@prisma/client';
import { ConfigurationType } from '@server/configuration';
import Axios, { AxiosError, AxiosInstance } from 'axios';
import {
  AccountProvider,
  AccountProviderError,
  LoginResult,
  LoginUrlResult,
  MpArticle,
  MpInfo,
  accountProviderTypes,
} from './account-provider.types';

@Injectable()
export class RemoteAccountProvider implements AccountProvider {
  readonly type = accountProviderTypes.REMOTE;
  private readonly request: AxiosInstance;

  constructor(configService: ConfigService) {
    const { url } =
      configService.get<ConfigurationType['platform']>('platform')!;
    this.request = Axios.create({ baseURL: url, timeout: 15 * 1e3 });
  }

  async getMpArticles(account: Account, mpId: string, page: number) {
    try {
      return await this.request
        .get<MpArticle[]>(`/api/v2/platform/mps/${mpId}/articles`, {
          headers: this.accountHeaders(account),
          params: { page },
        })
        .then((response) => response.data);
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  async getMpInfo(account: Account, url: string): Promise<MpInfo[]> {
    try {
      return await this.request
        .post<
          {
            id: string;
            cover: string;
            name: string;
            intro: string;
            updateTime: number;
          }[]
        >(
          '/api/v2/platform/wxs2mp',
          { url },
          { headers: this.accountHeaders(account) },
        )
        .then((response) => response.data);
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  async createLoginUrl(): Promise<LoginUrlResult> {
    return this.request
      .get<{ uuid: string; scanUrl: string }>('/api/v2/login/platform')
      .then((response) => ({
        ...response.data,
        provider: this.type,
      }));
  }

  async getLoginResult(id: string): Promise<LoginResult> {
    return this.request
      .get<{
        message: string;
        vid?: number;
        token?: string;
        username?: string;
      }>(`/api/v2/login/platform/${id}`, { timeout: 120 * 1e3 })
      .then((response) => ({
        ...response.data,
        provider: this.type,
      }));
  }

  private accountHeaders(account: Account) {
    return {
      xid: account.id,
      Authorization: `Bearer ${account.token}`,
    };
  }

  private toProviderError(error: unknown) {
    const axiosError = error as AxiosError<{ message?: string }>;
    const message =
      axiosError.response?.data?.message || axiosError.message || String(error);
    if (message.includes('WeReadError401')) {
      return new AccountProviderError('auth', message, 401);
    }
    if (message.includes('WeReadError429')) {
      return new AccountProviderError(
        'rate_limit',
        message,
        429,
        24 * 60 * 60 * 1000,
      );
    }
    if (message.includes('WeReadError400')) {
      return new AccountProviderError('bad_request', message, 400);
    }
    return new AccountProviderError('transient', message);
  }
}
