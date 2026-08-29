import { reconcileArticles } from './article-reconciliation';

describe('article reconciliation', () => {
  const mpId = 'MP_WXS_1';

  it('keeps the established article identity and removes a proven fetch-time alias', () => {
    const correct = {
      id: 'canonical_id',
      mpId,
      title: '同一篇文章',
      picUrl: 'https://example.test/cover.jpg',
      publishTime: 1_787_587_200,
      publishTimeEstimated: false,
      createdAt: new Date('2026-08-25T16:00:00Z'),
    };
    const duplicate = {
      ...correct,
      id: 'cover-alias',
      publishTime: 1_787_848_400,
      createdAt: new Date(1_787_848_400 * 1000),
    };

    const result = reconcileArticles(
      mpId,
      [
        {
          id: 'cover-alias',
          title: correct.title,
          picUrl: correct.picUrl,
          publishTime: correct.publishTime,
          publishTimeEstimated: false,
          source: 'cover',
        },
      ],
      [correct, duplicate],
      1_787_900_000,
    );

    expect(result.articles).toEqual([
      expect.objectContaining({
        id: 'canonical_id',
        publishTime: correct.publishTime,
        publishTimeEstimated: false,
      }),
    ]);
    expect(result.deleteIds).toEqual(['cover-alias']);
  });

  it('does not merge equal titles when their covers differ', () => {
    const result = reconcileArticles(
      mpId,
      [
        {
          id: 'new-id',
          title: '每周复盘',
          picUrl: 'new-cover',
          publishTime: 1_787_900_000,
          source: 'list',
        },
      ],
      [
        {
          id: 'old-id',
          mpId,
          title: '每周复盘',
          picUrl: 'old-cover',
          publishTime: 1_787_000_000,
          publishTimeEstimated: false,
          createdAt: new Date('2026-08-18T00:00:00Z'),
        },
      ],
    );

    expect(result.articles[0].id).toBe('new-id');
    expect(result.deleteIds).toEqual([]);
  });

  it('marks an unavailable cover timestamp as estimated', () => {
    const result = reconcileArticles(
      mpId,
      [
        {
          id: 'new-id',
          title: '最新文章',
          picUrl: 'cover',
          publishTime: 0,
          publishTimeEstimated: true,
          source: 'cover',
        },
      ],
      [],
      1_787_900_000,
    );

    expect(result.articles[0]).toEqual(
      expect.objectContaining({
        publishTime: 1_787_900_000,
        publishTimeEstimated: true,
      }),
    );
  });

  it('does not move the same estimated article to every new fetch time', () => {
    const storedTime = 1_787_800_000;
    const result = reconcileArticles(
      mpId,
      [
        {
          id: 'same-id',
          title: '发布时间未知',
          picUrl: 'cover',
          publishTime: 1_787_900_000,
          publishTimeEstimated: true,
          source: 'cover',
        },
      ],
      [
        {
          id: 'same-id',
          mpId,
          title: '发布时间未知',
          picUrl: 'cover',
          publishTime: storedTime,
          publishTimeEstimated: true,
          createdAt: new Date(storedTime * 1000),
        },
      ],
      1_788_000_000,
    );

    expect(result.articles[0]).toEqual(
      expect.objectContaining({
        publishTime: storedTime,
        publishTimeEstimated: true,
      }),
    );
  });
});
