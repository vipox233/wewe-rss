import {
  Avatar,
  Button,
  Checkbox,
  Divider,
  Listbox,
  ListboxItem,
  ListboxSection,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  Textarea,
  Tooltip,
  useDisclosure,
  Link,
} from '@nextui-org/react';
import { PlusIcon } from '@web/components/PlusIcon';
import { trpc } from '@web/utils/trpc';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { serverOriginUrl } from '@web/utils/env';
import ArticleList from './list';

type MpInfo = {
  id: string;
  name: string;
  cover: string;
  intro: string;
  updateTime: number;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const Feeds = () => {
  const { id } = useParams();

  const { isOpen, onOpen, onOpenChange, onClose } = useDisclosure();
  const { refetch: refetchFeedList, data: feedData } = trpc.feed.list.useQuery(
    {},
    {
      refetchOnWindowFocus: true,
    },
  );

  const navigate = useNavigate();

  const queryUtils = trpc.useUtils();

  const { mutateAsync: getMpInfo, isLoading: isGetMpInfoLoading } =
    trpc.platform.getMpInfo.useMutation({});
  const { data: accountProviderInfo } =
    trpc.platform.accountProviderInfo.useQuery();
  const { mutateAsync: listMps, isLoading: isListMpsLoading } =
    trpc.platform.listMps.useMutation({});
  const { mutateAsync: updateMpInfo } = trpc.feed.edit.useMutation({});

  const { mutateAsync: addFeed, isLoading: isAddFeedLoading } =
    trpc.feed.add.useMutation({});
  const { mutateAsync: refreshMpArticles, isLoading: isGetArticlesLoading } =
    trpc.feed.refreshArticles.useMutation();
  const {
    mutateAsync: getHistoryArticles,
    isLoading: isGetHistoryArticlesLoading,
  } = trpc.feed.getHistoryArticles.useMutation();

  const { data: inProgressHistoryMp, refetch: refetchInProgressHistoryMp } =
    trpc.feed.getInProgressHistoryMp.useQuery(undefined, {
      refetchOnWindowFocus: true,
      refetchInterval: 10 * 1e3,
      refetchOnMount: true,
      refetchOnReconnect: true,
    });

  const { data: isRefreshAllMpArticlesRunning } =
    trpc.feed.isRefreshAllMpArticlesRunning.useQuery();

  const { mutateAsync: deleteFeed, isLoading: isDeleteFeedLoading } =
    trpc.feed.delete.useMutation({});

  const [wxsLink, setWxsLink] = useState('');
  const [availableMps, setAvailableMps] = useState<MpInfo[]>([]);
  const [selectedMpIds, setSelectedMpIds] = useState<Set<string>>(new Set());

  const [currentMpId, setCurrentMpId] = useState(id || '');

  const addMp = async (item: MpInfo) => {
    await addFeed({
      id: item.id,
      mpName: item.name,
      mpCover: item.cover,
      mpIntro: item.intro,
      updateTime: item.updateTime,
      status: 1,
    });
    await refreshMpArticles({ mpId: item.id });
    toast.success('添加成功', {
      description: `公众号 ${item.name}`,
    });
  };

  const handleLoadMps = async () => {
    try {
      const items = await listMps();
      setWxsLink('');
      setAvailableMps(items);
      setSelectedMpIds(new Set());
      if (items.length === 0) {
        toast.error('没有找到公众号', {
          description: '请先在微信读书 App 中关注公众号，然后再刷新',
        });
      }
    } catch (error: unknown) {
      toast.error('读取已关注公众号失败', {
        description: getErrorMessage(error),
      });
    }
  };

  const handleConfirm = async () => {
    const wxsLinks =
      selectedMpIds.size > 0
        ? []
        : wxsLink.split('\n').filter((link) => link.trim() !== '');
    const items = new Map<string, MpInfo>();
    availableMps
      .filter((item) => selectedMpIds.has(item.id))
      .forEach((item) => items.set(item.id, item));

    try {
      for (const link of wxsLinks) {
        const resolved = await getMpInfo({ wxsLink: link.trim() });
        resolved.forEach((item) => items.set(item.id, item));
      }
      if (items.size === 0) {
        toast.error('添加失败', { description: '请选择公众号或输入分享链接' });
        return;
      }
      for (const item of items.values()) {
        await addMp(item);
      }
      await queryUtils.article.list.reset();
      await refetchFeedList();
      setWxsLink('');
      setAvailableMps([]);
      setSelectedMpIds(new Set());
      onClose();
    } catch (error: unknown) {
      toast.error('添加失败', {
        description: getErrorMessage(error),
      });
    }
  };

  const isActive = (key: string) => {
    return currentMpId === key;
  };

  const currentMpInfo = useMemo(() => {
    return feedData?.items.find((item) => item.id === currentMpId);
  }, [currentMpId, feedData?.items]);

  const handleExportOpml = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!feedData?.items?.length) {
      console.warn('没有订阅源');
      return;
    }

    let opmlContent = `<?xml version="1.0" encoding="UTF-8"?>
    <opml version="2.0">
      <head>
        <title>WeWeRSS 所有订阅源</title>
      </head>
      <body>
    `;

    feedData?.items.forEach((sub) => {
      opmlContent += `    <outline text="${sub.mpName}" type="rss" xmlUrl="${window.location.origin}/feeds/${sub.id}.atom" htmlUrl="${window.location.origin}/feeds/${sub.id}.atom"/>\n`;
    });

    opmlContent += `    </body>
    </opml>`;

    const blob = new Blob([opmlContent], { type: 'text/xml;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'WeWeRSS-All.opml';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <div className="h-full flex justify-between">
        <div className="w-64 p-4 h-full">
          <div className="pb-4 flex justify-between align-middle items-center">
            <Button
              color="primary"
              size="sm"
              onPress={onOpen}
              endContent={<PlusIcon />}
            >
              添加
            </Button>
            <div className="font-normal text-sm">
              共{feedData?.items.length || 0}个订阅
            </div>
          </div>

          {feedData?.items ? (
            <Listbox
              aria-label="订阅源"
              emptyContent="暂无订阅"
              onAction={(key) => setCurrentMpId(key as string)}
            >
              <ListboxSection showDivider>
                <ListboxItem
                  key={''}
                  href={`/feeds`}
                  className={isActive('') ? 'bg-primary-50 text-primary' : ''}
                  startContent={<Avatar name="ALL"></Avatar>}
                >
                  全部
                </ListboxItem>
              </ListboxSection>

              <ListboxSection className="overflow-y-auto h-[calc(100vh-260px)]">
                {feedData?.items.map((item) => {
                  return (
                    <ListboxItem
                      href={`/feeds/${item.id}`}
                      className={
                        isActive(item.id) ? 'bg-primary-50 text-primary' : ''
                      }
                      key={item.id}
                      startContent={<Avatar src={item.mpCover}></Avatar>}
                    >
                      {item.mpName}
                    </ListboxItem>
                  );
                }) || []}
              </ListboxSection>
            </Listbox>
          ) : (
            ''
          )}
        </div>
        <div className="flex-1 h-full flex flex-col">
          <div className="p-4 pb-0 flex justify-between">
            <h3 className="text-medium font-mono flex-1 overflow-hidden text-ellipsis break-keep text-nowrap pr-1">
              {currentMpInfo?.mpName || '全部'}
            </h3>
            {currentMpInfo ? (
              <div className="flex h-5 items-center space-x-4 text-small">
                <div className="font-light">
                  最后更新时间:
                  {dayjs(currentMpInfo.syncTime * 1e3).format(
                    'YYYY-MM-DD HH:mm:ss',
                  )}
                </div>
                <Divider orientation="vertical" />
                <Tooltip
                  content="频繁调用可能会导致一段时间内不可用"
                  color="danger"
                >
                  <Link
                    size="sm"
                    href="#"
                    isDisabled={isGetArticlesLoading}
                    onClick={async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      await refreshMpArticles({ mpId: currentMpInfo.id });
                      await refetchFeedList();
                      await queryUtils.article.list.reset();
                    }}
                  >
                    {isGetArticlesLoading ? '更新中...' : '立即更新'}
                  </Link>
                </Tooltip>
                <Divider orientation="vertical" />
                {currentMpInfo.hasHistory === 1 && (
                  <>
                    <Tooltip
                      content={
                        inProgressHistoryMp?.id === currentMpInfo.id
                          ? `正在获取第${inProgressHistoryMp.page}页...`
                          : `历史文章需要分批次拉取，请耐心等候，频繁调用可能会导致一段时间内不可用`
                      }
                      color={
                        inProgressHistoryMp?.id === currentMpInfo.id
                          ? 'primary'
                          : 'danger'
                      }
                    >
                      <Link
                        size="sm"
                        href="#"
                        isDisabled={
                          (inProgressHistoryMp?.id
                            ? inProgressHistoryMp?.id !== currentMpInfo.id
                            : false) ||
                          isGetHistoryArticlesLoading ||
                          isGetArticlesLoading
                        }
                        onClick={async (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();

                          if (inProgressHistoryMp?.id === currentMpInfo.id) {
                            await getHistoryArticles({
                              mpId: '',
                            });
                          } else {
                            await getHistoryArticles({
                              mpId: currentMpInfo.id,
                            });
                          }

                          await refetchInProgressHistoryMp();
                        }}
                      >
                        {inProgressHistoryMp?.id === currentMpInfo.id
                          ? `停止获取历史文章`
                          : `获取历史文章`}
                      </Link>
                    </Tooltip>
                    <Divider orientation="vertical" />
                  </>
                )}

                <Tooltip content="启用服务端定时更新">
                  <div>
                    <Switch
                      size="sm"
                      onValueChange={async (value) => {
                        await updateMpInfo({
                          id: currentMpInfo.id,
                          data: {
                            status: value ? 1 : 0,
                          },
                        });

                        await refetchFeedList();
                      }}
                      isSelected={currentMpInfo?.status === 1}
                    ></Switch>
                  </div>
                </Tooltip>
                <Divider orientation="vertical" />
                <Tooltip content="仅删除订阅源，已获取的文章不会被删除">
                  <Link
                    href="#"
                    color="danger"
                    size="sm"
                    isDisabled={isDeleteFeedLoading}
                    onClick={async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();

                      if (window.confirm('确定删除吗？')) {
                        await deleteFeed(currentMpInfo.id);
                        navigate('/feeds');
                        await refetchFeedList();
                      }
                    }}
                  >
                    删除
                  </Link>
                </Tooltip>

                <Divider orientation="vertical" />
                <Tooltip
                  content={
                    <div>
                      可添加.atom/.rss/.json格式输出, limit=20&page=1控制分页
                    </div>
                  }
                >
                  <Link
                    size="sm"
                    showAnchorIcon
                    target="_blank"
                    href={`${serverOriginUrl}/feeds/${currentMpInfo.id}.atom`}
                    color="foreground"
                  >
                    RSS
                  </Link>
                </Tooltip>
              </div>
            ) : (
              <div className="flex gap-2">
                <Tooltip
                  content="频繁调用可能会导致一段时间内不可用"
                  color="danger"
                >
                  <Link
                    size="sm"
                    href="#"
                    isDisabled={
                      isRefreshAllMpArticlesRunning || isGetArticlesLoading
                    }
                    onClick={async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      await refreshMpArticles({});
                      await refetchFeedList();
                      await queryUtils.article.list.reset();
                    }}
                  >
                    {isRefreshAllMpArticlesRunning || isGetArticlesLoading
                      ? '更新中...'
                      : '更新全部'}
                  </Link>
                </Tooltip>
                <Link
                  href="#"
                  color="foreground"
                  onClick={handleExportOpml}
                  size="sm"
                >
                  导出OPML
                </Link>
                <Divider orientation="vertical" />
                <Link
                  size="sm"
                  showAnchorIcon
                  target="_blank"
                  href={`${serverOriginUrl}/feeds/all.atom`}
                  color="foreground"
                >
                  RSS
                </Link>
              </div>
            )}
          </div>
          <div className="p-2 overflow-y-auto">
            <ArticleList></ArticleList>
          </div>
        </div>
      </div>
      <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                添加公众号源
              </ModalHeader>
              <ModalBody>
                {accountProviderInfo?.canListMps && (
                  <>
                    <Button
                      variant="flat"
                      color="primary"
                      onPress={handleLoadMps}
                      isLoading={isListMpsLoading}
                    >
                      从微信读书已关注列表导入
                    </Button>
                    {availableMps.length > 0 && (
                      <div className="max-h-64 overflow-y-auto rounded-medium border border-default-200 p-2">
                        {availableMps.map((item) => (
                          <Checkbox
                            key={item.id}
                            className="flex max-w-full py-2"
                            isSelected={selectedMpIds.has(item.id)}
                            onValueChange={(selected) => {
                              if (selected) setWxsLink('');
                              setSelectedMpIds((current) => {
                                const next = new Set(current);
                                if (selected) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              });
                            }}
                          >
                            {item.name}
                          </Checkbox>
                        ))}
                      </div>
                    )}
                    <Divider />
                  </>
                )}
                <Textarea
                  value={wxsLink}
                  onValueChange={(value) => {
                    setWxsLink(value);
                    if (value.trim()) setSelectedMpIds(new Set());
                  }}
                  autoFocus
                  label="或使用分享链接"
                  placeholder="输入公众号文章分享链接，一行一条，如 https://mp.weixin.qq.com/s/xxxxxx https://mp.weixin.qq.com/s/xxxxxx"
                  variant="bordered"
                />
              </ModalBody>
              <ModalFooter>
                <Button color="danger" variant="flat" onPress={onClose}>
                  取消
                </Button>
                <Button
                  color="primary"
                  isDisabled={
                    !wxsLink.startsWith('https://mp.weixin.qq.com/s/') &&
                    selectedMpIds.size === 0
                  }
                  onPress={handleConfirm}
                  isLoading={
                    isAddFeedLoading ||
                    isGetMpInfoLoading ||
                    isListMpsLoading ||
                    isGetArticlesLoading
                  }
                >
                  确定
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
};

export default Feeds;
