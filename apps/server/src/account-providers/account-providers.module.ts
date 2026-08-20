import { Module } from '@nestjs/common';
import { PrismaModule } from '@server/prisma/prisma.module';
import { AccountProviderRegistry } from './account-provider.registry';
import { LocalWeReadProvider } from './local-weread.provider';
import { RemoteAccountProvider } from './remote-account.provider';

@Module({
  imports: [PrismaModule],
  providers: [
    AccountProviderRegistry,
    LocalWeReadProvider,
    RemoteAccountProvider,
  ],
  exports: [AccountProviderRegistry],
})
export class AccountProvidersModule {}
