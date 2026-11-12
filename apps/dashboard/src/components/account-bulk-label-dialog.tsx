import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/dashboard/components/ui/dialog'
import { Button } from '@/dashboard/components/ui/button'
import { Input } from '@/dashboard/components/ui/input'
import { Label } from '@/dashboard/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/dashboard/components/ui/tabs'
import { Tag, Plus, Trash2, Search, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { LabelServiceGenerator } from '@/dashboard/services/label.service'
import { AccountServiceGenerator } from '@/dashboard/services/account.service'
import { API_URL } from '@/dashboard/constants/api-url.cont'
import { useAuth } from '@/dashboard/context-providers/auth.provider'

interface AccountBulkLabelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: string[]
  productVariantId?: string
  onSuccess?: () => void
}

const COLOR_PRESETS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#64748b', // slate
]

export function AccountBulkLabelDialog({
  open,
  onOpenChange,
  selectedIds,
  productVariantId = '',
  onSuccess,
}: AccountBulkLabelDialogProps) {
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState('#3b82f6')

  const auth = useAuth()
  const queryClient = useQueryClient()

  const labelService = useMemo(
    () => LabelServiceGenerator(API_URL, auth.tenant!.accessToken, auth.tenant!.id),
    [auth.tenant],
  )

  const accountService = useMemo(
    () => AccountServiceGenerator(API_URL, auth.tenant!.accessToken, auth.tenant!.id),
    [auth.tenant],
  )

  const { data: labels, isLoading } = useQuery({
    queryKey: ['labels', productVariantId],
    queryFn: () => labelService.findAll(productVariantId),
    enabled: open,
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; color: string; product_variant_id: string }) =>
      labelService.create(data),
    onSuccess: (newLabel) => {
      queryClient.invalidateQueries({ queryKey: ['labels', productVariantId] })
      setNewLabelName('')
      setShowCreateForm(false)
      setSelectedLabelIds((prev) => [...prev, newLabel.id])
      toast.success(`Label "${newLabel.name}" berhasil dibuat`)
    },
    onError: (err: any) => {
      toast.error(`Gagal membuat label: ${err.message}`)
    },
  })

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const action = mode === 'add' ? 'add_label' : 'remove_label'
      await accountService.bulkAction(selectedIds, action, { label_ids: selectedLabelIds })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account'] })
      toast.success(
        mode === 'add'
          ? `Berhasil menambahkan label ke ${selectedIds.length} akun`
          : `Berhasil melepas label dari ${selectedIds.length} akun`,
      )
      setSelectedLabelIds([])
      onSuccess?.()
      onOpenChange(false)
    },
    onError: (err: any) => {
      toast.error(`Gagal memproses label massal: ${err.message}`)
    },
  })

  const filteredLabels = useMemo(() => {
    if (!labels) return []
    if (!searchQuery.trim()) return labels
    const query = searchQuery.toLowerCase().trim()
    return labels.filter((l) => l.name.toLowerCase().includes(query))
  }, [labels, searchQuery])

  const toggleSelectLabel = (id: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    )
  }

  const handleSelectAll = () => {
    if (filteredLabels.length === 0) return
    const allFilteredIds = filteredLabels.map((l) => l.id)
    const isAllSelected = allFilteredIds.every((id) => selectedLabelIds.includes(id))

    if (isAllSelected) {
      setSelectedLabelIds((prev) => prev.filter((id) => !allFilteredIds.includes(id)))
    } else {
      setSelectedLabelIds((prev) => Array.from(new Set([...prev, ...allFilteredIds])))
    }
  }

  const handleCreateLabel = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newLabelName.trim()) return
    createMutation.mutate({
      name: newLabelName.trim(),
      color: newLabelColor,
      product_variant_id: productVariantId,
    })
  }

  const handleClose = () => {
    setSelectedLabelIds([])
    setSearchQuery('')
    setShowCreateForm(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Tag className="size-5 text-primary" />
            <DialogTitle>Kelola Label Massal</DialogTitle>
          </div>
          <DialogDescription>
            Pilih label untuk dipasang atau dilepas pada{' '}
            <span className="font-semibold text-foreground">{selectedIds.length} akun</span> yang dipilih.
          </DialogDescription>
        </DialogHeader>

        {/* Tab Mode (Tambah / Hapus) */}
        <div className="mt-2">
          <Tabs value={mode} onValueChange={(val) => setMode(val as 'add' | 'remove')}>
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="add" className="gap-2">
                <Plus className="size-4" />
                Tambah Label
              </TabsTrigger>
              <TabsTrigger value="remove" className="gap-2">
                <Trash2 className="size-4" />
                Hapus Label
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Search & Actions Bar */}
        <div className="flex items-center justify-between gap-2 mt-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Cari nama label..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs"
            />
          </div>
          {filteredLabels.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSelectAll}
              className="h-9 text-xs shrink-0"
            >
              {filteredLabels.every((l) => selectedLabelIds.includes(l.id))
                ? 'Batal Pilih Semua'
                : 'Pilih Semua'}
            </Button>
          )}
        </div>

        {/* Label Badges Container */}
        <div className="border rounded-md p-3 max-h-56 overflow-y-auto space-y-2 bg-muted/20">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
              <Loader2 className="size-4 animate-spin" /> Memuat daftar label...
            </div>
          ) : filteredLabels.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              {searchQuery ? 'Label tidak ditemukan.' : 'Belum ada label untuk varian ini.'}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {filteredLabels.map((lbl) => {
                const isSelected = selectedLabelIds.includes(lbl.id)
                return (
                  <button
                    key={lbl.id}
                    type="button"
                    onClick={() => toggleSelectLabel(lbl.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-all cursor-pointer ${
                      isSelected
                        ? 'ring-2 ring-primary ring-offset-1 bg-opacity-30 font-semibold'
                        : 'opacity-80 hover:opacity-100 hover:border-foreground/50'
                    }`}
                    style={{
                      backgroundColor: lbl.color ? `${lbl.color}25` : 'rgba(255,255,255,0.08)',
                      borderColor: lbl.color || 'var(--border)',
                      color: lbl.color || 'inherit',
                    }}
                  >
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: lbl.color || 'var(--border)' }}
                    />
                    <span>{lbl.name}</span>
                    {isSelected && <Check className="size-3.5 ml-1" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Inline Create Label Form */}
        <div className="border-t pt-3">
          {!showCreateForm ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowCreateForm(true)}
              className="h-8 text-xs text-muted-foreground hover:text-foreground p-0 gap-1"
            >
              <Plus className="size-3.5" /> Buat Label Baru
            </Button>
          ) : (
            <form onSubmit={handleCreateLabel} className="space-y-3 bg-muted/40 p-3 rounded-md border">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Buat Label Baru</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCreateForm(false)}
                  className="h-6 w-6 p-0 text-muted-foreground"
                >
                  ✕
                </Button>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Nama Label</Label>
                <Input
                  placeholder="Misal: Admin Gilang / Akun Cadangan..."
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  className="h-8 text-xs"
                  autoFocus
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Pilih Warna</Label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {COLOR_PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewLabelColor(color)}
                      className={`w-6 h-6 rounded-full border transition-all ${
                        newLabelColor === color ? 'ring-2 ring-primary ring-offset-1 scale-110' : 'opacity-80'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <input
                    type="color"
                    value={newLabelColor}
                    onChange={(e) => setNewLabelColor(e.target.value)}
                    className="w-6 h-6 rounded border cursor-pointer p-0 bg-transparent"
                    title="Pilih warna kustom"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCreateForm(false)}
                  className="h-7 text-xs"
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!newLabelName.trim() || createMutation.isPending}
                  className="h-7 text-xs gap-1"
                >
                  {createMutation.isPending && <Loader2 className="size-3 animate-spin" />}
                  Simpan Label
                </Button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="gap-2 sm:gap-0 mt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClose}
            disabled={bulkMutation.isPending}
            className="text-xs"
          >
            Batal
          </Button>
          <Button
            type="button"
            variant={mode === 'remove' ? 'destructive' : 'default'}
            onClick={() => bulkMutation.mutate()}
            disabled={selectedLabelIds.length === 0 || bulkMutation.isPending}
            className="text-xs gap-1.5"
          >
            {bulkMutation.isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Memproses...
              </>
            ) : mode === 'add' ? (
              <>
                <Plus className="size-3.5" />
                Pasang {selectedLabelIds.length > 0 ? `(${selectedLabelIds.length})` : ''} ke{' '}
                {selectedIds.length} Akun
              </>
            ) : (
              <>
                <Trash2 className="size-3.5" />
                Lepas {selectedLabelIds.length > 0 ? `(${selectedLabelIds.length})` : ''} dari{' '}
                {selectedIds.length} Akun
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

