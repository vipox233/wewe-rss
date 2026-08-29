import { FC, useCallback, useMemo, useState } from 'react';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  getKeyValue,
  Button,
  Spinner,
  Link,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';

const readStorageKey = 'wewe-rss:read-articles:v1';

type ArticleListItem = {
  id: string;
  mpId: string;
  title: string;
  picUrl: string;
  publishTime: number;
  publishTimeEstimated?: boolean;
};

function articleIdentityKey(item: ArticleListItem) {
  const id = String(item.id || '').trim();
  const normalizedTitle = String(item.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  const picUrl = String(item.picUrl || '').trim();
  return picUrl
    ? `content:${item.mpId}:${id.replace(/~/g, '_')}:${normalizedTitle}:${picUrl}`
    : `id:${item.mpId}:${id}`;
}

function articleReadKeys(item: ArticleListItem) {
  const normalizedTitle = String(item.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  const picUrl = String(item.picUrl || '').trim();
  return [
    articleIdentityKey(item),
    ...(normalizedTitle && picUrl
      ? [`content:${item.mpId}:${normalizedTitle}:${picUrl}`]
      : []),
  ];
}

function dedupeArticles(items: ArticleListItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = articleIdentityKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const ArticleList: FC = () => {
  const { id } = useParams();

  const mpId = id || '';
  const [readKeys, setReadKeys] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = JSON.parse(localStorage.getItem(readStorageKey) || '[]');
      return new Set<string>(
        Array.isArray(stored)
          ? stored.filter((value): value is string => typeof value === 'string')
          : [],
      );
    } catch {
      return new Set();
    }
  });

  const { data, fetchNextPage, isLoading, hasNextPage } =
    trpc.article.list.useInfiniteQuery(
      {
        limit: 20,
        mpId: mpId,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
    );

  const items = useMemo(() => {
    const items = data
      ? data.pages.reduce(
          (acc, page) => [...acc, ...page.items],
          [] as ArticleListItem[],
        )
      : [];

    return dedupeArticles(items);
  }, [data]);

  const markRead = useCallback((item: ArticleListItem) => {
    setReadKeys((current) => {
      const next = new Set(current);
      articleReadKeys(item).forEach((key) => next.add(key));
      localStorage.setItem(readStorageKey, JSON.stringify([...next]));
      return next;
    });
  }, []);

  return (
    <div>
      <Table
        classNames={{
          base: 'h-full',
          table: 'min-h-[420px]',
        }}
        aria-label="文章列表"
        bottomContent={
          hasNextPage && !isLoading ? (
            <div className="flex w-full justify-center">
              <Button
                isDisabled={isLoading}
                variant="flat"
                onPress={() => {
                  fetchNextPage();
                }}
              >
                {isLoading && <Spinner color="white" size="sm" />}
                加载更多
              </Button>
            </div>
          ) : null
        }
      >
        <TableHeader>
          <TableColumn key="title">标题</TableColumn>
          <TableColumn width={180} key="publishTime">
            发布时间
          </TableColumn>
        </TableHeader>
        <TableBody
          isLoading={isLoading}
          emptyContent={'暂无数据'}
          items={items || []}
          loadingContent={<Spinner />}
        >
          {(item) => (
            <TableRow key={item.id}>
              {(columnKey) => {
                let value = getKeyValue(item, columnKey);

                if (columnKey === 'publishTime') {
                  value = item.publishTimeEstimated
                    ? '待确认'
                    : dayjs(value * 1e3).format('YYYY-MM-DD HH:mm:ss');
                  return <TableCell>{value}</TableCell>;
                }

                if (columnKey === 'title') {
                  return (
                    <TableCell>
                      <Link
                        className={
                          articleReadKeys(item).some((key) => readKeys.has(key))
                            ? 'text-neutral-400'
                            : 'visited:text-neutral-400'
                        }
                        isBlock
                        showAnchorIcon
                        color="foreground"
                        target="_blank"
                        href={`https://mp.weixin.qq.com/s/${item.id}`}
                        onClick={() => markRead(item)}
                      >
                        {value}
                      </Link>
                    </TableCell>
                  );
                }
                return <TableCell>{value}</TableCell>;
              }}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
};

export default ArticleList;
