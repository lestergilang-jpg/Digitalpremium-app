'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Copy, Key, BookOpen, Mail, User, Clock, Hash, Loader2, Calendar, ShoppingBag, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Navbar } from '@/components/navbar'
import { Footer } from '@/components/footer'
import { EmailPortal } from '@/components/email-portal'
import { NetflixLoginGuide } from '@/components/netflix-login-guide'
import Link from 'next/link'
import { useTenant } from '@/hooks/use-tenant'

export default function HistoryPage() {
  const [identifier, setIdentifier] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [purchases, setPurchases] = useState<any[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { tenantId } = useTenant()

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!identifier.trim()) {
      toast.error('Masukkan email atau nomor WhatsApp terlebih dahulu')
      return
    }

    setIsLoading(true)
    setHasSearched(true)
    try {
      const { data } = await api.get(`/public/purchases`, {
        params: { identifier: identifier.trim() }
      })
      setPurchases(data || [])
      if (data && data.length > 0) {
        setExpandedId(data[0].id) // Expand the first transaction by default
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Gagal mencari riwayat pembelian')
      setPurchases([])
    } finally {
      setIsLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success('Disalin ke clipboard')
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  return (
    <main className="min-h-screen flex flex-col pt-40 pb-0 bg-background">
      <Navbar />
      
      <div className="flex-grow container mx-auto max-w-4xl px-6 mb-32">
        <div className="text-center mb-16">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 mb-6"
          >
            <Clock className="size-4 text-primary" />
            <span className="text-[10px] font-black tracking-[0.3em] text-primary uppercase">Riwayat Pembelian</span>
          </motion.div>
          <h1 className="text-4xl md:text-7xl font-black mb-6 text-foreground tracking-tight">Cari <span className="bg-clip-text text-transparent bg-gradient-to-br from-primary to-primary/80">Riwayat Anda.</span></h1>
          <p className="text-muted-foreground text-lg font-medium max-w-2xl mx-auto leading-relaxed">Masukkan email atau nomor WhatsApp yang Anda gunakan saat mengisi form pembelian.</p>
        </div>

        {/* Search Box */}
        <div className="bg-background rounded-[48px] p-8 md:p-14 border border-border shadow-2xl relative overflow-hidden mb-12">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10/50 blur-[60px] rounded-full -translate-y-1/2 translate-x-1/2" />
          
          <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-4 relative z-10">
            <div className="relative flex-grow">
              <Search className="absolute left-6 top-1/2 -translate-y-1/2 size-6 text-slate-400" />
              <input 
                type="text"
                placeholder="Masukkan Email / No. WhatsApp (cth: 0812...)"
                className="w-full bg-muted/50 border border-border rounded-2xl pl-16 pr-6 py-5 text-lg font-black focus:outline-none focus:border-primary transition-all text-foreground placeholder:text-slate-400"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
              />
            </div>
            <button 
              disabled={isLoading}
              className="px-10 py-5 bg-primary text-primary-foreground font-black rounded-2xl hover:bg-primary/90 hover:scale-[1.02] active:scale-95 transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50 shrink-0 text-sm uppercase tracking-widest shadow-xl shadow-primary/20"
            >
              {isLoading ? <Loader2 className="size-5 animate-spin" /> : 'Cari Riwayat'}
            </button>
          </form>
        </div>

        {/* Results */}
        <AnimatePresence mode="wait">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="size-12 animate-spin text-primary mb-4" />
              <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">Memuat Riwayat Transaksi...</p>
            </div>
          ) : hasSearched && purchases.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="text-center py-20 bg-background rounded-[40px] border border-dashed border-border"
            >
              <AlertCircle className="size-16 text-slate-200 mx-auto mb-6" />
              <p className="text-foreground font-black text-lg mb-2">Riwayat Tidak Ditemukan</p>
              <p className="text-slate-400 text-sm font-medium max-w-sm mx-auto">Pastikan Anda mengetik email atau nomor telepon yang tepat sesuai dengan saat checkout.</p>
            </motion.div>
          ) : purchases.length > 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-6"
            >
              <p className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">Ditemukan {purchases.length} Transaksi</p>
              
              {purchases.map((purchase) => {
                const isExpanded = expandedId === purchase.id
                const formattedDate = new Date(purchase.created_at).toLocaleDateString('id-ID', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })

                return (
                  <div 
                    key={purchase.id}
                    className="bg-background rounded-[32px] border border-border overflow-hidden transition-all duration-300 hover:border-primary/20 shadow-md"
                  >
                    {/* Accordion Header */}
                    <button 
                      onClick={() => toggleExpand(purchase.id)}
                      className="w-full text-left p-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-muted/10 transition-colors"
                    >
                      <div className="flex gap-4 items-center">
                        <div className="size-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                          <ShoppingBag className="size-6" />
                        </div>
                        <div>
                          <h4 className="text-lg md:text-xl font-black text-foreground">{purchase.product_variant?.product?.name || 'Produk'}</h4>
                          <div className="flex flex-wrap items-center gap-3 mt-1.5">
                            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{purchase.product_variant?.name || 'Varian'}</span>
                            <span className="text-xs font-medium text-slate-400">•</span>
                            <div className="flex items-center gap-1 text-xs text-slate-400">
                              <Calendar className="size-3.5" />
                              <span>{formattedDate}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 self-end md:self-center">
                        <span className="px-4 py-1.5 rounded-full text-[10px] font-black tracking-[0.2em] uppercase bg-primary/10 text-primary border border-primary/20">
                          {purchase.id}
                        </span>
                        {isExpanded ? <ChevronUp className="size-5 text-slate-400" /> : <ChevronDown className="size-5 text-slate-400" />}
                      </div>
                    </button>

                    {/* Accordion Content */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3 }}
                          className="border-t border-border bg-muted/10"
                        >
                          <div className="p-8 md:p-12 space-y-10">
                            
                            {/* Kredensial Akun */}
                            {purchase.account ? (() => {
                              const displayConfig = purchase.product_variant?.redeem_display_config;
                              const showEmail = displayConfig?.show_email ?? true;
                              const showPassword = displayConfig?.show_password ?? true;
                              const showProfile = displayConfig?.show_profile_name ?? true;
                              const showExpired = displayConfig?.show_expired_at ?? true;
                              const showInstruction = displayConfig?.show_copy_template ?? true;
                              const showPortal = displayConfig?.show_buyer_portal ?? true;
                              const customFields = (displayConfig?.custom_fields ?? []) as { label: string; value: string }[];
                              
                              const resolve = (val: string) => {
                                if (!val) return '';
                                let resolved = val
                                  .replace(/\$\$email/g, purchase.account.email || '')
                                  .replace(/\$$password/g, purchase.account.password || '')
                                  .replace(/\$\$profile/g, purchase.account.profile_name || '-')
                                  .replace(/\$\$product/g, purchase.product_variant?.product?.name || '')
                                  .replace(/\$\$expired/g, purchase.account.expired_at ? new Date(purchase.account.expired_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '-');
                                
                                if (purchase.account.metadata) {
                                  let metaObj = purchase.account.metadata;
                                  if (typeof metaObj === 'string') {
                                    try { metaObj = JSON.parse(metaObj) } catch(e) {}
                                  }
                                  if (typeof metaObj === 'object' && metaObj !== null) {
                                    Object.entries(metaObj).forEach(([key, value]) => {
                                      const regex = new RegExp(`\\$\\$metadata\\.${key}`, 'g');
                                      resolved = resolved.replace(regex, String(value || ''));
                                    });
                                  }
                                }
                                return resolved;
                              };

                              return (
                                <div className="space-y-10">
                                  {purchase.product_variant?.product?.name?.toLowerCase().includes('netflix') && purchase.access_token && (
                                    <NetflixLoginGuide token={purchase.access_token} email={purchase.account.email} />
                                  )}

                                  {(showEmail || showPassword) && (
                                    <div className={cn(
                                      "grid gap-6",
                                      (showEmail && showPassword) ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                                    )}>
                                      {showEmail && (
                                        <div className="flex items-center gap-4 bg-background px-6 py-4 rounded-2xl border border-border group transition-all hover:border-primary">
                                          <div className="bg-primary/10 p-2.5 rounded-xl shrink-0">
                                            <Mail className="size-5 text-primary" />
                                          </div>
                                          <div className="flex-grow overflow-hidden">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Email / Username</p>
                                            <p className="text-sm font-mono font-medium text-foreground truncate">{purchase.account.email}</p>
                                          </div>
                                          <button onClick={() => copyToClipboard(purchase.account.email)} className="text-primary hover:text-destructive transition-colors shrink-0 p-1">
                                            <Copy className="size-4" />
                                          </button>
                                        </div>
                                      )}
                                      {showPassword && (
                                        <div className="flex items-center gap-4 bg-background px-6 py-4 rounded-2xl border border-border group transition-all hover:border-primary">
                                          <div className="bg-primary/10 p-2.5 rounded-xl shrink-0">
                                            <Key className="size-5 text-primary" />
                                          </div>
                                          <div className="flex-grow overflow-hidden">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Password</p>
                                            <p className="text-sm font-mono font-medium text-foreground truncate">{purchase.account.password}</p>
                                          </div>
                                          <button onClick={() => copyToClipboard(purchase.account.password)} className="text-primary hover:text-destructive transition-colors shrink-0 p-1">
                                            <Copy className="size-4" />
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {(showProfile || showExpired) && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                      {showProfile && (
                                        <div className="flex items-center gap-4 bg-background px-6 py-4 rounded-2xl border border-border">
                                          <div className="bg-primary/10 p-2.5 rounded-xl shrink-0">
                                            <User className="size-5 text-primary" />
                                          </div>
                                          <div className="flex-grow overflow-hidden">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Nama Profil</p>
                                            <p className="text-sm font-medium text-foreground truncate">{purchase.account.profile_name || '-'}</p>
                                          </div>
                                        </div>
                                      )}
                                      {showExpired && (
                                        <div className="flex items-center gap-4 bg-background px-6 py-4 rounded-2xl border border-border">
                                          <div className="bg-primary/10 p-2.5 rounded-xl shrink-0">
                                            <Clock className="size-5 text-primary" />
                                          </div>
                                          <div className="flex-grow overflow-hidden">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Masa Aktif</p>
                                            <p className="text-sm font-medium text-foreground truncate">
                                              {new Date(purchase.account.expired_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}
                                            </p>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Custom Fields */}
                                  {(() => {
                                    const validCustomFields = customFields.filter(field => {
                                      const resolved = resolve(field.value);
                                      return resolved && !resolved.includes('$$');
                                    });
                                    if (validCustomFields.length === 0) return null;
                                    return (
                                      <div className={cn(
                                        "grid gap-6",
                                        validCustomFields.length > 1 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                                      )}>
                                        {validCustomFields.map((field, idx) => {
                                          const resolvedValue = resolve(field.value);
                                          return (
                                            <div key={idx} className="flex items-center gap-4 bg-background px-6 py-4 rounded-2xl border border-border group transition-all hover:border-primary">
                                              <div className="bg-primary/10 p-2.5 rounded-xl shrink-0">
                                                <Hash className="size-5 text-primary" />
                                              </div>
                                              <div className="flex-grow overflow-hidden">
                                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">{field.label}</p>
                                                <p className="text-sm font-mono font-medium text-foreground truncate">{resolvedValue}</p>
                                              </div>
                                              <button onClick={() => copyToClipboard(resolvedValue)} className="text-primary hover:text-destructive transition-colors shrink-0 p-1">
                                                <Copy className="size-4" />
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}

                                  {/* Instruksi Penggunaan */}
                                  {showInstruction && purchase.product_variant?.copy_template && (
                                    <div className="p-6 bg-primary/10 rounded-2xl border border-primary/20 border-l-4 border-l-primary">
                                      <p className="text-xs font-black text-primary uppercase tracking-[0.2em] mb-2">Instruksi Penggunaan</p>
                                      <p className="text-sm text-muted-foreground leading-relaxed font-bold italic whitespace-pre-wrap">{resolve(purchase.product_variant.copy_template)}</p>
                                    </div>
                                  )}

                                  {/* Portal Email (untuk OTP/Kode Netflix) */}
                                  {showPortal && purchase.access_token && (
                                    <div className="mt-4">
                                      <EmailPortal token={purchase.access_token} />
                                    </div>
                                  )}

                                  {/* Panduan & Tutorial */}
                                  {purchase.product_variant?.tutorial?.slug && purchase.access_token && (
                                    <div className="p-6 bg-muted/30 rounded-[24px] flex flex-col md:flex-row items-center justify-between gap-4">
                                      <div>
                                        <p className="text-xs font-black text-primary uppercase tracking-[0.2em] mb-1">📖 Panduan Penggunaan</p>
                                        <p className="text-xs text-slate-400 font-medium">Ikuti langkah-langkah penggunaan agar akun Anda aman dan awet.</p>
                                      </div>
                                      <Link
                                        href={`/tutorial/${purchase.product_variant.tutorial.slug}?token=${purchase.access_token}&tenant=${tenantId || 'master'}`}
                                        className="shrink-0 px-6 py-3 bg-background text-foreground hover:bg-primary hover:text-primary-foreground font-black rounded-xl transition-all flex items-center gap-2 text-xs shadow-md border border-border"
                                      >
                                        <BookOpen className="size-4" />
                                        Lihat Panduan
                                      </Link>
                                    </div>
                                  )}
                                </div>
                              );
                            })() : (
                              <div className="text-center py-6">
                                <AlertCircle className={cn("size-10 mx-auto mb-3", purchase.is_expired ? "text-destructive" : "text-amber-500")} />
                                <p className="text-foreground font-bold text-sm">
                                  {purchase.is_expired ? 'Masa Langganan Habis' : 'Detail Akun Belum Siap'}
                                </p>
                                <p className="text-slate-400 text-xs mt-1 max-w-md mx-auto">
                                  {purchase.is_expired 
                                    ? 'Masa aktif/durasi langganan akun Anda telah berakhir. Kredensial dan akses akun disembunyikan demi keamanan. Silakan lakukan pembelian baru untuk melanjutkan.'
                                    : 'Akun sedang diproses atau voucher belum diredeem. Silakan hubungi admin jika transaksi Anda bermasalah.'}
                                </p>
                                
                                {!purchase.is_expired && purchase.status === 'UNUSED' && (
                                  <Link
                                    href={`/redeem?code=${purchase.id}`}
                                    className="mt-6 inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground font-bold rounded-xl hover:bg-primary/90 transition-all text-xs uppercase tracking-wider shadow-md"
                                  >
                                    Claim Voucher Sekarang
                                  </Link>
                                )}
                              </div>
                            )}

                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <Footer />
    </main>
  )
}
