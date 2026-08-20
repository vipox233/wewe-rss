import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import {
  AccountProvider,
  AccountProviderType,
  accountProviderTypes,
} from './account-provider.types';
import { LocalWeReadProvider } from './local-weread.provider';
import { RemoteAccountProvider } from './remote-account.provider';

@Injectable()
export class AccountProviderRegistry {
  readonly defaultType: AccountProviderType;

  constructor(
    configService: ConfigService,
    private readonly remoteProvider: RemoteAccountProvider,
    private readonly localProvider: LocalWeReadProvider,
  ) {
    this.defaultType =
      configService.get<ConfigurationType['weread']>('weread')!.accountProvider;
  }

  get(type: string): AccountProvider {
    return type === accountProviderTypes.LOCAL
      ? this.localProvider
      : this.remoteProvider;
  }

  getDefault() {
    return this.get(this.defaultType);
  }

  getRemote() {
    return this.remoteProvider;
  }

  async renewLocalAccount(accountId: string) {
    return this.localProvider.renewAccount(accountId);
  }
}
