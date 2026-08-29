import type { Account } from '@prisma/client';

export const accountProviderTypes = {
  REMOTE: 'remote',
  LOCAL: 'local',
} as const;

export type AccountProviderType =
  (typeof accountProviderTypes)[keyof typeof accountProviderTypes];

export type MpArticle = {
  id: string;
  title: string;
  picUrl: string;
  publishTime: number;
  /** cover 接口不一定返回发布时间，此时只把抓取时间用于排序。 */
  publishTimeEstimated?: boolean;
  /** list 是完整列表，cover 只代表最新一篇，不能据此判断历史已取完。 */
  source?: 'list' | 'cover';
};

export type MpInfo = {
  id: string;
  name: string;
  cover: string;
  intro: string;
  updateTime: number;
};

export type LoginUrlResult = {
  uuid: string;
  scanUrl: string;
  provider: AccountProviderType;
  expiresIn?: number;
};

export type LoginResult = {
  message: string;
  provider: AccountProviderType;
  pending?: boolean;
  needOtp?: boolean;
  vid?: number | string;
  token?: string;
  username?: string;
};

export type AccountProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'transient';

export class AccountProviderError extends Error {
  constructor(
    public readonly kind: AccountProviderErrorKind,
    message: string,
    public readonly providerCode?: string | number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AccountProviderError';
  }
}

export interface AccountProvider {
  readonly type: AccountProviderType;

  createLoginUrl(): Promise<LoginUrlResult>;

  getLoginResult(id: string, otp?: string): Promise<LoginResult>;

  getMpInfo(account: Account, url: string): Promise<MpInfo[]>;

  listMps?(
    account: Account,
    options?: { forceRefresh?: boolean },
  ): Promise<MpInfo[]>;

  getMpArticles(
    account: Account,
    mpId: string,
    page: number,
  ): Promise<MpArticle[]>;
}
