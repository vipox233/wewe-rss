import { MpArticle } from './account-provider.types';
import { articleIdFromReviewId } from './weread-session';

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
      const id = info.originalId || articleIdFromReviewId(reviewId, mpId) || '';
      if (!id || !info.title) continue;
      articles.push({
        id,
        title: info.title,
        picUrl: info.pic_url || '',
        publishTime: Number(
          info.time || review.createTime || group.createTime || 0,
        ),
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
  const id = String(
    body?.originalId || articleIdFromReviewId(reviewId, mpId) || '',
  );
  if (!id || !body?.title) return null;
  return {
    id,
    title: String(body.title),
    picUrl: String(body.pic || body.pic_url || ''),
    publishTime: Number(
      body.publishTime ||
        body.time ||
        body.createTime ||
        Math.floor(Date.now() / 1000),
    ),
  };
}
