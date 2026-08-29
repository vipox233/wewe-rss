import { MpArticle } from './account-provider.types';
import { load } from 'cheerio';
import {
  articleIdFromReviewId,
  normalizeWeChatArticleId,
} from './weread-session';

export type ArticleListPayload = {
  errCode?: number | string;
  errMsg?: string;
  clearAll?: number;
  reviews?: Array<{
    createTime?: number;
    subReviews?: Array<{
      reviewId?: string;
      review?: {
        reviewId?: string;
        createTime?: number;
        mpInfo?: {
          title?: string;
          originalId?: string;
          pic_url?: string;
          time?: number;
        };
      };
    }>;
  }>;
};

export function parseMpArticleGroups(
  payload: ArticleListPayload,
  mpId: string,
) {
  const groups = payload.reviews || [];
  const articles: MpArticle[] = [];
  for (const group of groups) {
    for (const subReview of group.subReviews || []) {
      const review = subReview.review || {};
      const info = review.mpInfo || {};
      const reviewId = review.reviewId || subReview.reviewId || '';
      const id = normalizeWeChatArticleId(
        info.originalId || articleIdFromReviewId(reviewId, mpId) || '',
      );
      if (!id || !info.title) continue;
      const publishTime = normalizeEpochSeconds(
        info.time || review.createTime || group.createTime || 0,
      );
      articles.push({
        id,
        title: info.title,
        picUrl: info.pic_url || '',
        publishTime,
        publishTimeEstimated: publishTime === 0,
        source: 'list',
      });
    }
  }

  const times = groups
    .map((group) => Number(group.createTime || 0))
    .filter((value) => value > 0);
  return {
    articles,
    groupCount: groups.length,
    clearAll: Boolean(payload.clearAll),
    nextOffset: times.length ? Math.min(...times) : undefined,
  };
}

export function mapMpCoverArticle(body: any, mpId: string): MpArticle | null {
  const reviewId = String(body?.reviewId || '');
  const id = normalizeWeChatArticleId(
    String(body?.originalId || articleIdFromReviewId(reviewId, mpId) || ''),
  );
  if (!id || !body?.title) return null;
  const publishTime = normalizeEpochSeconds(
    body.publishTime || body.time || body.createTime || 0,
  );
  return {
    id,
    title: String(body.title),
    picUrl: String(body.pic || body.pic_url || ''),
    publishTime,
    publishTimeEstimated: publishTime === 0,
    source: 'cover',
  };
}

export type WeChatArticlePageMetadata = {
  id?: string;
  publishTime?: number;
};

export function extractWeChatArticlePageMetadata(
  html: string,
  requestUrl?: string,
): WeChatArticlePageMetadata {
  const $ = load(html || '');
  const canonicalUrls = [
    $('meta[property="og:url"]').attr('content'),
    $('link[rel="canonical"]').attr('href'),
    requestUrl,
  ];
  const id = canonicalUrls
    .map(articleIdFromShareUrl)
    .find((value): value is string => Boolean(value));

  const timestampCandidates: Array<string | number | undefined> = [
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="article:published_time"]').attr('content'),
    $('#publish_time').first().attr('data-timestamp'),
    $('#publish_time').first().text(),
  ];
  const scriptPatterns = [
    /(?:\bct\b|\bpublish_time\b)\s*[:=]\s*["']?(\d{10,13})/i,
    /["']publish_time["']\s*:\s*["']?(\d{10,13})/i,
  ];
  for (const pattern of scriptPatterns) {
    timestampCandidates.push(html.match(pattern)?.[1]);
  }

  const publishTime = timestampCandidates
    .map(parsePublishTime)
    .find((value) => value > 0);
  return { id, publishTime };
}

function articleIdFromShareUrl(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'mp.weixin.qq.com' ||
      !parsed.pathname.startsWith('/s/')
    ) {
      return undefined;
    }
    const id = decodeURIComponent(parsed.pathname.slice('/s/'.length));
    return id ? normalizeWeChatArticleId(id) : undefined;
  } catch {
    return undefined;
  }
}

function parsePublishTime(value?: string | number) {
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value || ''))) {
    return normalizeEpochSeconds(value || 0);
  }
  const text = String(value || '').trim();
  if (!text) return 0;

  const chineseDate = text.match(
    /^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  const timestamp = chineseDate
    ? Date.parse(
        `${chineseDate[1]}-${chineseDate[2].padStart(2, '0')}-${chineseDate[3].padStart(2, '0')}T${chineseDate[4].padStart(2, '0')}:${chineseDate[5]}:${chineseDate[6] || '00'}+08:00`,
      )
    : Date.parse(text);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function normalizeEpochSeconds(value: string | number) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
}
