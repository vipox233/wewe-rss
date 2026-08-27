import { Test, TestingModule } from '@nestjs/testing';
import { FeedsService } from './feeds.service';
import { PrismaService } from '@server/prisma/prisma.service';
import { TrpcService } from '@server/trpc/trpc.service';
import { ConfigService } from '@nestjs/config';

describe('FeedsService', () => {
  let service: FeedsService;
  const prisma = {
    feed: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const config = {
    get: jest.fn().mockReturnValue({
      enableCleanHtml: false,
      mode: 'summary',
      originUrl: 'https://rss.example.test',
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedsService,
        { provide: PrismaService, useValue: prisma },
        { provide: TrpcService, useValue: {} },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<FeedsService>(FeedsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('repairs legacy escaped IDs in RSS output without changing stored rows', async () => {
    const article = {
      id: 'Blu~n3lkMnH56xVQEdd7LQ',
      mpId: 'MP_WXS_1',
      title: '测试文章',
      picUrl: '',
      publishTime: 1_780_000_000,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const corrected = { ...article, id: 'Blu_n3lkMnH56xVQEdd7LQ' };

    const feed = await service.renderFeed({
      type: 'atom',
      feedInfo: {
        id: 'MP_WXS_1',
        mpName: '测试公众号',
        mpCover: '',
        mpIntro: '',
        status: 1,
        syncTime: 0,
        updateTime: 1_780_000_000,
        hasHistory: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      articles: [article, corrected],
      mode: 'summary',
    });
    const atom = feed.atom1();

    expect(feed.items).toHaveLength(1);
    expect(atom).toContain('Blu_n3lkMnH56xVQEdd7LQ');
    expect(atom).not.toContain('Blu~n3lkMnH56xVQEdd7LQ');
  });
});
