import { Test } from '@nestjs/testing';
import { AccountProviderRegistry } from '@server/account-providers/account-provider.registry';
import { PrismaService } from '@server/prisma/prisma.service';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('wires the account provider registry through the production module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(AccountProviderRegistry)).toBeDefined();
    await moduleRef.close();
  });
});
