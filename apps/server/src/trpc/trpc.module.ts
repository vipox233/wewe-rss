import { Module } from '@nestjs/common';
import { TrpcService } from '@server/trpc/trpc.service';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { PrismaModule } from '@server/prisma/prisma.module';
import { AccountProvidersModule } from '@server/account-providers/account-providers.module';

@Module({
  imports: [PrismaModule, AccountProvidersModule],
  controllers: [],
  providers: [TrpcService, TrpcRouter],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
