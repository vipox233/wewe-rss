import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Button,
  useDisclosure,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Chip,
  Input,
} from '@nextui-org/react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { PlusIcon } from '@web/components/PlusIcon';
import dayjs from 'dayjs';
import { StatusDropdown } from '@web/components/StatusDropdown';
import { trpc } from '@web/utils/trpc';
import { statusMap } from '@web/constants';
import { useEffect, useState } from 'react';

const AccountPage = () => {
  const { isOpen, onOpen, onClose, onOpenChange } = useDisclosure();
  const [count, setCount] = useState(0);
  const [otp, setOtp] = useState('');
  const [submittedOtp, setSubmittedOtp] = useState<string>();

  const { refetch, data, isFetching } = trpc.account.list.useQuery({});

  const queryUtils = trpc.useUtils();

  const { mutateAsync: updateAccount } = trpc.account.edit.useMutation({});

  const { mutateAsync: deleteAccount } = trpc.account.delete.useMutation({});

  const { mutateAsync: addAccount } = trpc.account.add.useMutation({});

  const { mutateAsync: renewAccount } = trpc.account.renew.useMutation({});

  const { mutateAsync, data: loginData } =
    trpc.platform.createLoginUrl.useMutation({
      onSuccess(data) {
        if (data.uuid) {
          setCount(data.expiresIn || 60);
          setOtp('');
          setSubmittedOtp(undefined);
        }
      },
    });

  const { data: loginResult } = trpc.platform.getLoginResult.useQuery(
    {
      id: loginData?.uuid ?? '',
      otp: submittedOtp,
    },
    {
      refetchIntervalInBackground: false,
      refetchInterval(data) {
        if (
          loginData?.provider !== 'local' ||
          data?.vid ||
          data?.message ||
          data?.needOtp
        ) {
          return false;
        }
        return 1500;
      },
      retry: false,
      enabled: !!loginData?.uuid && isOpen,
      async onSuccess(data) {
        if (data.needOtp && submittedOtp) {
          setSubmittedOtp(undefined);
        }
        if (data.vid && data.provider === 'local') {
          const name = data.username!;
          onClose();
          toast.success('添加成功', {
            description: `用户名：${name}(${data.vid})`,
          });
          refetch();
        } else if (data.vid && data.token) {
          const name = data.username!;
          await addAccount({
            id: `${data.vid}`,
            name,
            token: data.token,
            provider: 'remote',
          });

          onClose();
          toast.success('添加成功', {
            description: `用户名：${name}(${data.vid})`,
          });
          refetch();
        } else if (data.message && !data.needOtp) {
          toast.error(`登录失败: ${data.message}`);
        }
      },
    },
  );

  useEffect(() => {
    let timerId;
    if (count > 0 && isOpen) {
      timerId = setTimeout(() => {
        setCount(count - 1);
      }, 1000);
    }
    return () => timerId && clearTimeout(timerId);
  }, [count, isOpen]);

  return (
    <div>
      <div className="flex justify-between m-4">
        <div className="font-bold">共{data?.items.length || 0}个账号</div>
        <Button
          onPress={() => {
            onOpen();
            mutateAsync();
          }}
          size="sm"
          color="primary"
          endContent={<PlusIcon />}
        >
          添加读书账号
        </Button>
      </div>
      <Table aria-label="Example static collection table">
        <TableHeader>
          <TableColumn>ID</TableColumn>
          <TableColumn>用户名</TableColumn>
          <TableColumn>提供器</TableColumn>
          <TableColumn>状态</TableColumn>
          <TableColumn>最近续期</TableColumn>
          <TableColumn>操作</TableColumn>
        </TableHeader>
        <TableBody
          emptyContent={<div className="m-auto text-center">暂无数据</div>}
          isLoading={isFetching}
          loadingContent={<Spinner />}
        >
          {data?.items.map((item) => {
            const isBlocked = data?.blocks.includes(item.id);

            return (
              <TableRow key={item.id}>
                <TableCell>{item.id}</TableCell>
                <TableCell>{item.name}</TableCell>
                <TableCell>
                  <Chip size="sm" variant="flat">
                    {item.provider === 'local' ? '本地' : '远程'}
                  </Chip>
                </TableCell>
                <TableCell>
                  {isBlocked ? (
                    <Chip className="capitalize" size="sm" variant="flat">
                      今日小黑屋
                    </Chip>
                  ) : (
                    <Chip
                      className="capitalize"
                      color={statusMap[item.status].color}
                      size="sm"
                      variant="flat"
                    >
                      {statusMap[item.status].label}
                    </Chip>
                  )}
                </TableCell>
                <TableCell>
                  {dayjs(item.session?.lastRenewAt || item.updatedAt).format(
                    'YYYY-MM-DD HH:mm',
                  )}
                </TableCell>
                <TableCell className="flex gap-2">
                  <StatusDropdown
                    value={item.status}
                    onChange={(value) => {
                      updateAccount({
                        id: item.id,
                        data: { status: value },
                      }).then(() => {
                        toast.success('更新成功!');
                        refetch();
                      });
                    }}
                  ></StatusDropdown>

                  {item.provider === 'local' && (
                    <Button
                      size="sm"
                      onPress={() => {
                        renewAccount(item.id)
                          .then(() => {
                            toast.success('续期成功!');
                            refetch();
                          })
                          .catch((error) => {
                            toast.error(`续期失败: ${error.message}`);
                          });
                      }}
                    >
                      续期
                    </Button>
                  )}

                  <Button
                    size="sm"
                    color="danger"
                    onPress={() => {
                      deleteAccount(item.id).then(() => {
                        toast.success('删除成功!');
                        refetch();
                      });
                    }}
                  >
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            );
          }) || []}
        </TableBody>
      </Table>

      <Modal
        isOpen={isOpen}
        onOpenChange={async () => {
          onOpenChange();
          await queryUtils.platform.getLoginResult.cancel();
        }}
      >
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                添加读书账号
              </ModalHeader>
              <ModalBody>
                <div className="m-auto pb-8 text-center">
                  {loginData ? (
                    <div>
                      <div className="relative">
                        {loginResult?.message && !loginResult.needOtp && (
                          <div className="absolute top-0 left-0 bottom-0 right-0 bg-white bg-opacity-75 flex justify-center items-center">
                            <div className="text-xl">
                              {loginResult?.message}
                            </div>
                          </div>
                        )}
                        <QRCodeSVG size={150} value={loginData?.scanUrl} />
                      </div>
                      <div className="mt-4">
                        微信扫码登录{' '}
                        {!loginResult?.message && count > 0 && (
                          <span className="text-red-400">({count}s)</span>
                        )}
                      </div>
                      {loginResult?.needOtp && (
                        <div className="mt-4 flex flex-col gap-2">
                          <div className="text-sm text-warning">
                            {loginResult.message ||
                              '请填写手机上显示的四位验证码'}
                          </div>
                          <Input
                            value={otp}
                            maxLength={4}
                            inputMode="numeric"
                            label="四位验证码"
                            onValueChange={(value) =>
                              setOtp(value.replace(/\D/g, '').slice(0, 4))
                            }
                          />
                          <Button
                            color="primary"
                            isDisabled={!/^\d{4}$/.test(otp)}
                            onPress={() => setSubmittedOtp(otp)}
                          >
                            验证
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="m-auto flex justify-center align-middle items-center">
                      <Spinner />
                      二维码加载中
                    </div>
                  )}
                </div>
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
};

export default AccountPage;
