import type { MpArticle } from '@server/account-providers/account-provider.types';

export type StoredArticleSnapshot = {
  id: string;
  mpId: string;
  title: string;
  picUrl: string;
  publishTime: number;
  publishTimeEstimated: boolean;
  createdAt: Date;
};

export type ReconciledArticle = {
  id: string;
  mpId: string;
  title: string;
  picUrl: string;
  publishTime: number;
  publishTimeEstimated: boolean;
};

const fetchTimeToleranceMs = 15 * 60 * 1000;

/**
 * 将 cover/list 返回的文章与已入库记录对齐。
 *
 * 只有 ID 完全相同，或“标题 + 非空封面”相同且其中一条明显使用了入库时间
 * 时，才会把旧记录视为同一文章，避免按标题粗暴合并合法文章。
 */
export function reconcileArticles(
  mpId: string,
  incomingArticles: MpArticle[],
  storedArticles: StoredArticleSnapshot[],
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const deleteIds = new Set<string>();
  const working = [...storedArticles];
  const reconciled = new Map<string, ReconciledArticle>();

  for (const incoming of incomingArticles) {
    const candidates = working.filter(
      (stored) =>
        stored.mpId === mpId &&
        (sameArticleId(stored.id, incoming.id) ||
          sameArticleContent(stored, incoming)),
    );
    const exact = candidates.find((stored) => stored.id === incoming.id);
    const normalized = candidates.find((stored) =>
      sameArticleId(stored.id, incoming.id),
    );
    const contentMatches = candidates.filter((stored) =>
      sameArticleContent(stored, incoming),
    );
    const incomingEstimated =
      incoming.publishTimeEstimated || incoming.publishTime <= 0;
    const trustedContentMatches = contentMatches.filter(
      (stored) =>
        !stored.publishTimeEstimated &&
        !isLikelyFetchTime(stored) &&
        !incomingEstimated &&
        Math.abs(stored.publishTime - incoming.publishTime) <= 5 * 60,
    );

    // cover 的 exact 记录若明显是旧版“抓取时间”行，优先沿用同内容的可信旧行。
    const stored =
      (incoming.source === 'cover'
        ? trustedContentMatches.length === 1
          ? trustedContentMatches[0]
          : undefined
        : undefined) ||
      exact ||
      normalized;

    const canKeepStoredTime =
      stored &&
      !stored.publishTimeEstimated &&
      !isLikelyFetchTime(stored) &&
      incomingEstimated;
    const canKeepEstimatedStoredTime =
      stored && stored.publishTime > 0 && incomingEstimated;
    const publishTime =
      canKeepStoredTime || canKeepEstimatedStoredTime
        ? stored!.publishTime
        : incoming.publishTime > 0
          ? incoming.publishTime
          : nowSeconds;
    const publishTimeEstimated = canKeepStoredTime ? false : incomingEstimated;
    const hasTrustedPublishTime =
      !incomingEstimated ||
      Boolean(
        stored && !stored.publishTimeEstimated && !isLikelyFetchTime(stored),
      );
    const id = stored?.id || incoming.id;
    const article: ReconciledArticle = {
      id,
      mpId,
      title: incoming.title,
      picUrl: incoming.picUrl || stored?.picUrl || '',
      publishTime,
      publishTimeEstimated,
    };
    reconciled.set(id, article);

    for (const candidate of candidates) {
      if (candidate.id === id) continue;
      if (
        sameArticleContent(candidate, article) &&
        isLikelyAliasForIncoming(candidate, incoming) &&
        hasTrustedPublishTime
      ) {
        deleteIds.add(candidate.id);
      }
    }

    const index = working.findIndex((candidate) => candidate.id === id);
    const snapshot: StoredArticleSnapshot = {
      ...article,
      createdAt: stored?.createdAt || new Date(nowSeconds * 1000),
    };
    if (index >= 0) working[index] = snapshot;
    else working.push(snapshot);
  }

  for (const id of reconciled.keys()) deleteIds.delete(id);
  return { articles: [...reconciled.values()], deleteIds: [...deleteIds] };
}

function sameArticleId(left: string, right: string) {
  return left === right;
}

function sameArticleContent(
  left: Pick<StoredArticleSnapshot, 'title' | 'picUrl'>,
  right: Pick<MpArticle, 'title' | 'picUrl'>,
) {
  const leftPic = left.picUrl.trim();
  const rightPic = right.picUrl.trim();
  return (
    normalizeTitle(left.title) === normalizeTitle(right.title) &&
    Boolean(leftPic) &&
    leftPic === rightPic
  );
}

function normalizeTitle(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function isLikelyFetchTime(
  article: Pick<StoredArticleSnapshot, 'publishTime' | 'createdAt'>,
) {
  return (
    Math.abs(article.publishTime * 1000 - article.createdAt.getTime()) <=
    fetchTimeToleranceMs
  );
}

function isLikelyAliasForIncoming(
  stored: StoredArticleSnapshot,
  incoming: MpArticle,
) {
  if (incoming.publishTimeEstimated || incoming.publishTime <= 0) return false;
  return (
    isLikelyFetchTime(stored) &&
    stored.createdAt.getTime() - incoming.publishTime * 1000 >
      fetchTimeToleranceMs
  );
}
