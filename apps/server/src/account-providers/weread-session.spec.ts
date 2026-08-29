import {
  SessionCodec,
  articleIdFromReviewId,
  mergeSetCookie,
  parseWeChatArticleShareUrl,
  toCookieHeader,
} from './weread-session';
import {
  extractWeChatArticlePageMetadata,
  mapMpCoverArticle,
  parseMpArticleGroups,
} from './weread-articles';

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
                    originalId: 'Blu_n3lkMnH56xVQEdd7LQ',
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
        id: 'Blu_n3lkMnH56xVQEdd7LQ',
        title: '文章标题',
        picUrl: 'https://example.test/cover.jpg',
        publishTime: 101,
        publishTimeEstimated: false,
        source: 'list',
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
      publishTimeEstimated: false,
      source: 'cover',
    });
    expect(articleIdFromReviewId('MP_WXS_1_a_b', 'MP_WXS_1')).toBe('a_b');
    expect(
      articleIdFromReviewId('MP_WXS_1_Blu~n3lkMnH56xVQEdd7LQ', 'MP_WXS_1'),
    ).toBe('Blu~n3lkMnH56xVQEdd7LQ');
  });

  it('does not invent a cover publish time and reads canonical page metadata', () => {
    expect(
      mapMpCoverArticle(
        {
          reviewId: 'MP_WXS_1_alias-token',
          title: '最新文章',
          pic: 'cover',
        },
        'MP_WXS_1',
      ),
    ).toEqual({
      id: 'alias-token',
      title: '最新文章',
      picUrl: 'cover',
      publishTime: 0,
      publishTimeEstimated: true,
      source: 'cover',
    });

    expect(
      extractWeChatArticlePageMetadata(
        `
          <meta property="og:url" content="https://mp.weixin.qq.com/s/canonical_token">
          <script>var ct = "1787932800";</script>
        `,
        'https://mp.weixin.qq.com/s/alias-token',
      ),
    ).toEqual({ id: 'canonical_token', publishTime: 1_787_932_800 });
  });

  it('accepts both WeChat article URL forms and rejects unsafe variants', () => {
    expect(
      parseWeChatArticleShareUrl('https://mp.weixin.qq.com/s/article-id'),
    ).not.toBeNull();
    expect(
      parseWeChatArticleShareUrl(
        'https://mp.weixin.qq.com/s?__biz=MzXXX&mid=123&idx=1&sn=abc',
      ),
    ).not.toBeNull();
    expect(
      parseWeChatArticleShareUrl(
        'https://mp.weixin.qq.com.attacker.example/s/article-id',
      ),
    ).toBeNull();
    expect(
      parseWeChatArticleShareUrl('https://user@mp.weixin.qq.com/s/article-id'),
    ).toBeNull();
    expect(
      parseWeChatArticleShareUrl('https://mp.weixin.qq.com:444/s/article-id'),
    ).toBeNull();
  });
});
