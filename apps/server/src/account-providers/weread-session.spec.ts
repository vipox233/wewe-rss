import {
  SessionCodec,
  articleIdFromReviewId,
  mergeSetCookie,
  toCookieHeader,
} from './weread-session';
import { mapMpCoverArticle, parseMpArticleGroups } from './weread-articles';

describe('WeRead session helpers', () => {
  it('merges rotated cookies and removes expired values', () => {
    const cookies = mergeSetCookie(
      { wr_vid: '1', wr_skey: 'old', ignored: 'keep' },
      [
        'wr_skey=new-token; Path=/; HttpOnly',
        'wr_rt=refresh-token; Path=/',
        'wr_vid=; Max-Age=0; Path=/',
        'unrelated=value; Path=/',
      ],
    );

    expect(cookies).toEqual({
      wr_skey: 'new-token',
      wr_rt: 'refresh-token',
      ignored: 'keep',
    });
    expect(toCookieHeader(cookies)).toBe(
      'ignored=keep; wr_rt=refresh-token; wr_skey=new-token',
    );
  });

  it('encrypts and decrypts the complete session snapshot', () => {
    const codec = new SessionCodec('test-secret');
    const state = {
      cookies: { wr_vid: '123', wr_skey: 'token' },
      ticket: 'ticket',
      lastRenewAt: '2026-08-18T00:00:00.000Z',
    };
    const encoded = codec.encode(state);

    expect(encoded.startsWith('enc:v1:')).toBe(true);
    expect(encoded).not.toContain('token');
    expect(codec.decode(encoded)).toEqual(state);
  });

  it('maps list and cover responses to the existing RSS article shape', () => {
    const parsed = parseMpArticleGroups(
      {
        reviews: [
          {
            createTime: 100,
            subReviews: [
              {
                review: {
                  reviewId: 'MP_WXS_1_article-token',
                  createTime: 101,
                  mpInfo: {
                    title: '文章标题',
                    originalId: 'original-token',
                    pic_url: 'https://example.test/cover.jpg',
                  },
                },
              },
            ],
          },
        ],
      },
      'MP_WXS_1',
    );

    expect(parsed.articles).toEqual([
      {
        id: 'original-token',
        title: '文章标题',
        picUrl: 'https://example.test/cover.jpg',
        publishTime: 101,
      },
    ]);
    expect(parsed.nextOffset).toBe(100);
    expect(
      mapMpCoverArticle(
        {
          reviewId: 'MP_WXS_1_latest-token',
          title: '最新文章',
          pic: 'cover',
          createTime: 102,
        },
        'MP_WXS_1',
      ),
    ).toEqual({
      id: 'latest-token',
      title: '最新文章',
      picUrl: 'cover',
      publishTime: 102,
    });
    expect(articleIdFromReviewId('MP_WXS_1_a_b', 'MP_WXS_1')).toBe('a_b');
  });
});
