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
  'auth' | 'rate_limit' | 'bad_request' | 'transient';

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

  getMpArticles(
    account: Account,
    mpId: string,
    page: number,
  ): Promise<MpArticle[]>;
}
