import type { DateRange } from 'react-day-picker'
import type { Account, AccountProfile } from '@/dashboard/services/account.service'
import type {
  Transaction,
  TransactionFilter,
} from '@/dashboard/services/transaction.service'
import type { OrderByDirection } from '@/dashboard/types/order-by.type'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  Calendar,
  CircleQuestionMark,
  Copy,
  Globe,
  LayoutDashboard,
  Plus,
  ShoppingBag,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useDebouncedCallback } from 'use-debounce'
import { ShopeeLogo } from '@/dashboard/components/icons/shopee-logo'
import { WhatsappLogo } from '@/dashboard/components/icons/whatsapp-logo'
import { NoData } from '@/dashboard/components/no-data'
import { Pagination } from '@/dashboard/components/pagination'
import { PermissionGate } from '@/dashboard/components/permission-gate'
import { Button } from '@/dashboard/components/ui/button'
import { Calendar as CalendarInput } from '@/dashboard/components/ui/calendar'
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/dashboard/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/dashboard/components/ui/dialog'
import { Input } from '@/dashboard/components/ui/input'
import { Label } from '@/dashboard/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/dashboard/components/ui/select'
import { Skeleton } from '@/dashboard/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/dashboard/components/ui/table'
import { API_URL } from '@/dashboard/constants/api-url.cont'
import { useGlobalAlertDialog } from '@/dashboard/context-providers/alert-dialog.provider'
import { useAuth } from '@/dashboard/context-providers/auth.provider'
import { useSocket } from '@/dashboard/context-providers/socket.provider'
import { copyAccountTemplate } from '@/dashboard/lib/copy-template'
import { formatRupiah } from '@/dashboard/lib/currency.util'
import { formatDateIdStandard } from '@/dashboard/lib/time-converter.util'
import {
  GetTransactionParamsSchema,
  TransactionServiceGenerator,
} from '@/dashboard/services/transaction.service'
import { AccountServiceGenerator } from '@/dashboard/services/account.service'

export const Route = createFileRoute('/dashboard/transaction/')({
  component: RouteComponent,
  validateSearch: GetTransactionParamsSchema,
})

function RouteComponent() {
  const searchParam = Route.useSearch()
  const navigate = Route.useNavigate()
  const auth = useAuth()
  const { socket } = useSocket()
  const queryClient = useQueryClient()
  const { showAlertDialog, hideAlertDialog } = useGlobalAlertDialog()
  const transactionService = TransactionServiceGenerator(
    API_URL,
    auth.tenant!.accessToken,
    auth.tenant!.id,
  )
  const accountService = AccountServiceGenerator(
    API_URL,
    auth.tenant!.accessToken,
    auth.tenant!.id,
  )

  const [filter, setFilter] = useState<TransactionFilter>({
    customer: searchParam.customer || '',
    from_date: searchParam.from_date || '',
    to_date: searchParam.to_date || '',
  })
  const [sort, setSort] = useState<string>(
    !!searchParam.order_by && !!searchParam.order_direction
      ? `${searchParam.order_by}:${searchParam.order_direction}`
      : 'default',
  )

  const [dialogTransactionUserOpen, setDialogTransactionUserOpen]
    = useState<boolean>(false)
  const [dialogFilterOpen, setDialogFilterOpen] = useState<boolean>(false)

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction>()
  const [selectedDateRange, setSelectedDateRange] = useState<DateRange>()
  const [netflixTokenCache, setNetflixTokenCache] = useState<Record<string, any>>({})

  const { data: transactions, isLoading: isFetchTransactionLoading } = useQuery(
    {
      queryKey: ['transaction', searchParam],
      queryFn: ({ signal }) => transactionService.getAllTransaction({ ...searchParam, signal }),
    },
  )

  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactionService.deleteTransaction(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transaction'] })
      toast.success('Transaksi berhasil dihapus.')
    },
    onError: (error) => {
      toast.error(`Gagal menghapus transaksi: ${error.message}`)
    },
    onSettled: () => {
      hideAlertDialog()
    },
  })

  const handleDeleteTransaction = (transaction: Transaction) => {
    showAlertDialog({
      title: 'Yakin ingin menghapus Transaksi?',
      description: (
        <>
          Aksi tidak dapat dibatalkan. Ini akan menghapus Transaksi
          <span className="font-bold">
            {' '}
            {transaction.id}
            {' '}
          </span>
          secara permanen.
        </>
      ),
      confirmText: 'Hapus',
      isConfirming: deleteMutation.isPending,
      onConfirm: () => deleteMutation.mutate(transaction.id),
    })
  }

  const handleViewItemDetail = (transaction: Transaction) => {
    setSelectedTransaction(transaction)
    setDialogTransactionUserOpen(true)
  }

  const handleCopyTemplate = async (profile: AccountProfile, account: Account) => {
    const fetchToken = async () => {
      if (netflixTokenCache[account.id]) {
        return netflixTokenCache[account.id]
      }
      const response = await accountService.getNetflixToken(account.id)
      if (response.status === 'processing') {
        if (!socket) {
          throw new Error('Koneksi socket terputus, silakan coba lagi')
        }
        
        const tokenData = await new Promise((resolve, reject) => {
          const eventName = `task:${response.taskId}:done`
          socket.emit('subscribe-event', { eventName })
          
          const handleTokenEvent = (data: { eventName: string, payload: any }) => {
            if (data.eventName === eventName) {
              socket.off('event', handleTokenEvent)
              socket.emit('unsubscribe-event', { eventName })
              
              if (data.payload.status === 'COMPLETED') {
                resolve(data.payload.payload)
              } else {
                reject(new Error(data.payload.message || 'Gagal memproses token dari Bot'))
              }
            }
          }
          
          socket.on('event', handleTokenEvent)
          
          setTimeout(() => {
            socket.off('event', handleTokenEvent)
            socket.emit('unsubscribe-event', { eventName })
            reject(new Error('Bot tidak merespons dalam 30 detik (Timeout)'))
          }, 30000)
        })
        
        setNetflixTokenCache(prev => ({ ...prev, [account.id]: tokenData as any }))
        return tokenData as any
      }
      setNetflixTokenCache(prev => ({ ...prev, [account.id]: response }))
      return response
    }
    
    toast.promise(
      copyAccountTemplate(profile, account, fetchToken).then((template) => {
        const fallbackCopyTextToClipboard = (text: string) => {
      const textArea = document.createElement("textarea")
      textArea.value = text
      textArea.style.top = "0"
      textArea.style.left = "0"
      textArea.style.position = "fixed"
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      try {
        const successful = document.execCommand('copy')
        if (successful) {
          toast.success('Akun berhasil di copy')
        } else {
          toast.error('Gagal mengcopy (silakan copy manual)')
        }
      } catch (err) {
        console.error('Fallback error', err)
        toast.error('Gagal mengcopy (silakan copy manual)')
      }
      document.body.removeChild(textArea)
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(template)
        .then(() => toast.success('Akun berhasil di copy'))
        .catch((err) => {
          console.error(err)
          fallbackCopyTextToClipboard(template)
        })
    } else {
      fallbackCopyTextToClipboard(template)
    }
      }),
      {
        loading: 'Menyiapkan template...',
        success: 'Selesai disiapkan',
        error: 'Gagal menyiapkan template akun',
      }
    )
  }

  const handleSearchCustomer = useDebouncedCallback((value: string) => {
    setFilter({ ...filter, customer: value })
    const customer = value || undefined
    navigate({
      search: prev => ({ ...prev, customer, page: 1 }),
      replace: true,
    })
  }, 700)

  const handleDateRangeSelect = (dateRange?: DateRange) => {
    setSelectedDateRange(dateRange || undefined)
    setFilter({
      ...filter,
      from_date: dateRange?.from?.toISOString() || '',
      to_date: dateRange?.to?.toISOString() || '',
    })
  }

  const handleSortChange = (value: string) => {
    setSort(value)

    const [orderBy, orderDirection]
      = value === 'default' ? [undefined, undefined] : value.split(':')
    navigate({
      search: prev => ({
        ...prev,
        order_by: orderBy,
        order_direction: orderDirection as OrderByDirection | undefined,
        page: 1,
      }),
      replace: true,
    })
  }

  const handlePaginationChange = (page: number) => {
    navigate({
      search: prev => ({
        ...prev,
        page,
      }),
      replace: true,
    })
  }

  const handleFilterApply = () => {
    navigate({
      search: prev => ({
        ...prev,
        ...filter,
      }),
      replace: true,
    })
    setDialogFilterOpen(false)
  }

  const handleFilterClear = () => {
    setFilter({
      customer: '',
      from_date: '',
      to_date: '',
    })
    setSelectedDateRange(undefined)
    navigate({
      search: prev => ({
        ...prev,
        customer: undefined,
        from_date: undefined,
        to_date: undefined,
      }),
      replace: true,
    })
    setDialogFilterOpen(false)
  }

  return (
    <>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col md:flex-row gap-6 justify-between items-center">
          <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight text-balance">
            Transaksi
          </h1>
          <PermissionGate permission="transaction.create">
            <Button asChild>
              <Link to="/dashboard/transaction/create">
                <span>
                  <Plus />
                </span>
                {' '}
                Transaksi Baru
              </Link>
            </Button>
          </PermissionGate>
        </div>
        <div className="flex flex-col md:flex-row justify-center items-center gap-4">
          <Input
            type="text"
            defaultValue={filter.customer}
            placeholder="Cari Customer..."
            onChange={e => handleSearchCustomer(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => {
              setDialogFilterOpen(true)
            }}
            className="cursor-pointer w-full md:w-min"
          >
            <SlidersHorizontal className="size-4" />
            {' '}
            Filter
          </Button>
          <div className="flex items-center gap-2 w-full md:w-min">
            <p className="text-sm">Urutkan:</p>
            <Select defaultValue={sort} onValueChange={handleSortChange}>
              <SelectTrigger className="w-full md:w-min">
                <SelectValue placeholder="Theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Terbaru</SelectItem>
                <SelectItem value="created_at:asc">Terlama</SelectItem>
                <SelectItem value="total_price:desc">
                  Harga Tertinggi
                </SelectItem>
                <SelectItem value="total_price:asc">Harga Terendah</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {!!transactions && (
          <div className="flex items-center justify-center">
            <Pagination
              currentPage={transactions.paginationData.currentPage}
              totalPages={transactions.paginationData.totalPage}
              onPageChange={handlePaginationChange}
            />
          </div>
        )}
        {isFetchTransactionLoading
          ? (
              <Skeleton className="h-16 w-full rounded-md" />
            )
          : transactions?.items.length
            ? (
                <Table>
                  <TableHeader className="bg-secondary text-secondary-foreground">
                    <TableRow className="*:p-4">
                      <TableHead className="w-[100px] hidden lg:table-cell">ID</TableHead>
                      <TableHead className="hidden md:table-cell">Tanggal</TableHead>
                      <TableHead>Preview Item</TableHead>
                      <TableHead className="hidden lg:table-cell">Customer</TableHead>
                      <TableHead className="hidden lg:table-cell">Platform</TableHead>
                      <TableHead className="hidden lg:table-cell">Harga</TableHead>
                      <TableHead className="text-center lg:text-right">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.items.map(transaction => (
                      <TableRow key={transaction.id} className="*:px-2 lg:*:px-4 *:py-4 lg:*:py-6">
                        <TableCell className="hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {transaction.id}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="flex gap-2 items-center">
                            <Calendar className="size-4" />
                            <p className="text-xs lg:text-sm">{formatDateIdStandard(transaction.created_at)}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          {transaction.items.length
                            ? (
                                <div className="flex gap-2 items-center">
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={() => {
                                      handleCopyTemplate(
                                        transaction.items[0].user!.profile,
                                        transaction.items[0].user!.account,
                                      )
                                    }}
                                    className="cursor-pointer"
                                  >
                                    <Copy className="size-4" />
                                  </Button>
                                  <div className="max-w-[150px] lg:max-w-none">
                                    <p className="font-bold truncate">
                                      {transaction.items[0].user?.account.email.email}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                      {
                                        transaction.items[0].user?.account.product_variant
                                          .product
                                          ?.name
                                      }
                                      {' '}
                                      {
                                        transaction.items[0].user?.account.product_variant
                                          .name
                                      }
                                      {' '}
                                      (
                                      {transaction.items[0].user?.profile.name}
                                      )
                                    </p>
                                  </div>
                                </div>
                              )
                            : (
                                <span className="italic">No Item</span>
                              )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div>
                            <p>{transaction.customer}</p>
                            {transaction.buyer_whatsapp && (
                              <p className="text-xs text-muted-foreground">{transaction.buyer_whatsapp}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex gap-2 items-center">
                            {transaction.platform === 'Shopee'
                              ? (
                                  <div className="p-1 bg-orange-500/20 text-orange-500 w-min rounded-md">
                                    <ShopeeLogo className="size-6" />
                                  </div>
                                )
                              : transaction.platform === 'Whatsapp'
                                ? (
                                    <div className="p-1 bg-emerald-500/20 text-emerald-500 w-min rounded-md">
                                      <WhatsappLogo className="size-6" />
                                    </div>
                                  )
                                : transaction.platform.toLowerCase() === 'dashboard'
                                  ? (
                                      <div className="p-1 bg-primary/20 text-primary w-min rounded-md">
                                        <LayoutDashboard className="size-6" />
                                      </div>
                                    )
                                  : transaction.platform.toLowerCase() === 'landing' || transaction.platform.toLowerCase() === 'landingpage'
                                    ? (
                                        <div className="p-1 bg-primary/20 text-primary w-min rounded-md">
                                          <Globe className="size-6" />
                                        </div>
                                      )
                                    : (
                                          <div className="p-1 bg-neutral-500/20 text-neutral-500 w-min rounded-md">
                                            <CircleQuestionMark className="size-6" />
                                          </div>
                                        )}
                              <div>
                                <p>{transaction.platform}</p>
                                {transaction.shop && (
                                  <p className="text-xs text-muted-foreground">{transaction.shop.name}</p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        <TableCell className="hidden lg:table-cell">{formatRupiah(transaction.total_price)}</TableCell>
                        <TableCell className="text-center lg:text-right">
                          <div className="flex justify-center lg:justify-end gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                handleViewItemDetail(transaction)
                              }}
                              className="cursor-pointer"
                              title={`${transaction.items.length} Item`}
                            >
                              <ShoppingBag className="size-4" />
                              <span className="hidden lg:inline ml-1">
                                {' '}
                                {transaction.items.length}
                                {' '}
                                Item
                              </span>
                            </Button>
                            <PermissionGate permission="transaction.delete">
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => {
                                  handleDeleteTransaction(transaction)
                                }}
                                className="cursor-pointer"
                                title="Hapus"
                              >
                                <Trash2 className="size-4" />
                                <span className="hidden lg:inline ml-1">
                                  {' '}
                                  Hapus
                                </span>
                              </Button>
                            </PermissionGate>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            : (
                <NoData>Transaksi tidak ditemukan</NoData>
              )}
        {!!transactions && (
          <div className="flex items-center justify-center">
            <Pagination
              currentPage={transactions.paginationData.currentPage}
              totalPages={transactions.paginationData.totalPage}
              onPageChange={handlePaginationChange}
            />
          </div>
        )}
      </div>
      {/* Transaction Item Detail Dialog */}
      <Dialog
        open={dialogTransactionUserOpen}
        onOpenChange={setDialogTransactionUserOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Detail Item</DialogTitle>
          </DialogHeader>
          {selectedTransaction
            ? (
                <div>
                  {selectedTransaction.items.length
                    ? (
                        selectedTransaction.items.map(item => (
                          <Card key={item.id}>
                            <CardHeader>
                              <CardTitle>
                                {item.user?.account.product_variant.product?.name}
                                {' '}
                                {item.user?.account.product_variant.name}
                              </CardTitle>
                              <CardDescription>
                                {item.user?.account.email.email}
                                {' '}
                                (
                                {item.user?.profile.name}
                                )
                              </CardDescription>
                              {item.user && (
                                <CardAction>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    onClick={() => {
                                      handleCopyTemplate(
                                        item.user!.profile,
                                        item.user!.account,
                                      )
                                    }}
                                    className="cursor-pointer"
                                  >
                                    <Copy className="size-4" />
                                  </Button>
                                </CardAction>
                              )}
                            </CardHeader>
                          </Card>
                        ))
                      )
                    : (
                        <p>Tidak ada item</p>
                      )}
                </div>
              )
            : (
                <p>Tidak Ada Transaksi Terseleksi</p>
              )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" className="w-full">
                Tutup
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={dialogFilterOpen} onOpenChange={setDialogFilterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Filter Transaksi</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <Label>Range Tanggal</Label>
              <CalendarInput
                mode="range"
                selected={selectedDateRange}
                onSelect={handleDateRangeSelect}
                required={false}
                className="border rounded-md"
              />
              <p className="text-sm">
                {selectedDateRange
                  && `${formatDateIdStandard(selectedDateRange.from, true)} - ${formatDateIdStandard(selectedDateRange.to, true)}`}
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" className="cursor-pointer">
                Tutup
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              onClick={() => {
                handleFilterClear()
              }}
              className="cursor-pointer"
            >
              Clear
            </Button>
            <Button
              onClick={() => {
                handleFilterApply()
              }}
              className="cursor-pointer"
            >
              Terapkan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
