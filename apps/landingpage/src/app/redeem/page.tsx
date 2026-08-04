'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Copy, Check, ExternalLink, Loader2, Sparkles, Key, BookOpen, Mail, User, Clock, Hash } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Navbar } from '@/components/navbar'
import { Footer } from '@/components/footer'
import { EmailPortal } from '@/components/email-portal'
import { NetflixLoginGuide } from '@/components/netflix-login-guide'
import Link from 'next/link'
import { useTenant } from '@/hooks/use-tenant'
import { useNotification } from '@/hooks/use-notification'
import { useSearchParams } from 'next/navigation'

export default function RedeemPage() {
  const [code, setCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [copied, setCopied] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const { tenantId } = useTenant()
  const { markVoucherAsClaimed } = useNotification()
  const searchParams = useSearchParams()
  const urlCode = searchParams.get('code')

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!code) return

    setIsLoading(true)
    setResult(null)
    try {
      const { data } = await api.get(`/public/voucher/${code}`)
      setResult(data)
      if (data?.voucher?.status === 'USED' && data?.voucher?.access_token) {
        setAccessToken(data.voucher.access_token)
        markVoucherAsClaimed(code)
      } else {
        setAccessToken(null)
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Kode voucher tidak ditemukan')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (urlCode && !result && !isLoading) {
      setCode(urlCode.toUpperCase())
      const timer = setTimeout(() => {
        handleSearch()
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [urlCode, tenantId])

  const handleRedeem = async () => {
    setIsLoading(true)
    try {
      await api.post('/public/voucher/redeem', { voucher_code: code })
      markVoucherAsClaimed(code)
      toast.success('Voucher berhasil diredeem!')
      // Refresh data after success to ensure we have the full, parsed account object
      await handleSearch()
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Gagal meredeem voucher')
      setIsLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success('Disalin ke clipboard')
    setTimeout(() => setCopied(false), 2000)
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
            <Key className="size-4 text-primary" />
            <span className="text-[10px] font-black tracking-[0.3em] text-primary uppercase">Aktivasi Voucher</span>
          </motion.div>
          <h1 className="text-4xl md:text-7xl font-black mb-6 text-foreground tracking-tight">Tukar <span className="bg-clip-text text-transparent bg-gradient-to-br from-primary to-primary/80">Kode Voucher.</span></h1>
          <p className="text-muted-foreground text-lg font-medium max-w-2xl mx-auto leading-relaxed">Masukkan kode voucher unik Anda untuk mendapatkan detail layanan seketika.</p>
        </div>

        <div className="bg-background rounded-[48px] p-8 md:p-14 border border-border shadow-2xl relative overflow-hidden">
          {/* Subtle Accent */}
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10/50 blur-[60px] rounded-full -translate-y-1/2 translate-x-1/2" />

          <form onSubmit={handleSearch} className="flex flex-col md:flex-row gap-4 mb-12 relative z-10">
            <div className="relative flex-grow">
              <Search className="absolute left-6 top-1/2 -translate-y-1/2 size-6 text-slate-400" />
              <input 
                type="text"
                placeholder="VC-XXXXXXXX"
                className="w-full bg-muted/50 border border-border rounded-2xl pl-16 pr-6 py-5 text-xl font-black focus:outline-none focus:border-primary transition-all text-foreground placeholder:text-slate-300 uppercase"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
              />
            </div>
            <button 
              disabled={isLoading}
              className="px-10 py-5 bg-primary text-primary-foreground font-black rounded-2xl hover:bg-primary/90 hover:scale-[1.02] active:scale-95 transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50 shrink-0 text-sm uppercase tracking-widest shadow-xl shadow-primary/20"
            >
              {isLoading ? <Loader2 className="size-5 animate-spin" /> : 'Cek Sekarang'}
            </button>
          </form>

          <AnimatePresence mode="wait">
            {result && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="space-y-10 pt-12 border-t border-border relative z-10"
              >
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                  <div>
                    <h4 className="text-3xl md:text-4xl font-black text-foreground tracking-tight">{result?.voucher?.product_variant?.product?.name || 'Produk'}</h4>
                    <div className="flex items-center gap-3 mt-3">
                      <span className="text-sm font-bold text-slate-400 uppercase tracking-widest">{result?.voucher?.product_variant?.name || 'Varian'}</span>
                      <span className={`px-4 py-1.5 rounded-full text-[10px] font-black tracking-[0.2em] uppercase ${
                        result.voucher.status === 'USED' 
                        ? 'bg-destructive/10 text-destructive border border-destructive/20' 
                        : result.voucher.status === 'PENDING'
                        ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                        : result.voucher.status === 'EXPIRED'
                        ? 'bg-muted/50 text-muted-foreground border border-border'
                        : 'bg-primary/10 text-primary border border-primary/20'
                      }`}>
                        {result.voucher.status === 'USED' 
                          ? `Voucher diklaim oleh ${result.voucher.buyer_name}` 
                          : result.voucher.status === 'PENDING'
                          ? 'Belum Dibayar'
                          : result.voucher.status === 'EXPIRED'
                          ? 'Kadaluarsa'
                          : 'Siap Digunakan'}
                      </span>
                    </div>
                  </div>
                  
                  {result?.voucher?.status === 'UNUSED' && result?.voucher?.payment_status === 'PAID' && (
                    <button 
                      onClick={handleRedeem}
                      disabled={isLoading}
                      className="w-full md:w-auto px-12 py-5 bg-gradient-to-br from-primary to-primary/80 text-primary-foreground font-black rounded-2xl hover:scale-105 transition-all flex items-center justify-center gap-3 shadow-xl shadow-primary/20"
                    >
                      {isLoading ? <Loader2 className="size-5 animate-spin" /> : 'Aktivasi Sekarang'}
                    </button>
                  )}
                </div>

                {result.account && (() => {
                  const displayConfig = result.voucher.product_variant?.redeem_display_config;
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
                      .replace(/\$\$email/g, result.account.email || '')
                      .replace(/\$\$password/g, result.account.password || '')
                      .replace(/\$\$profile/g, result.account.profile_name || '-')
                      .replace(/\$\$product/g, result.voucher.product_variant?.product?.name || '')
                      .replace(/\$\$expired/g, result.account.expired_at ? new Date(result.account.expired_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '-');
                    
                    if (result.account.metadata) {
                      let metaObj = result.account.metadata;
                      // Handle case where metadata might be a JSON string
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
                      {result?.voucher?.product_variant?.product?.name?.toLowerCase().includes('netflix') && accessToken && (
                        <NetflixLoginGuide token={accessToken} email={result.account.email} />
                      )}
                      {(showEmail || showPassword) && (
                        <div className={cn(
                          "grid gap-8",
                          (showEmail && showPassword) ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                        )}>
                          {showEmail && (
                            <div className="flex items-center gap-4 bg-background px-6 py-4 rounded-2xl border border-border group transition-all hover:border-primary">
                              <div className="bg-primary/10 p-2.5 rounded-xl shrink-0">
                                <Mail className="size-5 text-primary" />
                              </div>
                              <div className="flex-grow overflow-hidden">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Email / Username</p>
                                <p className="text-base font-mono font-medium text-foreground truncate">{result.account.email}</p>
                              </div>
                              <button onClick={() => copyToClipboard(result.account.email)} className="text-primary hover:text-destructive transition-colors shrink-0 p-1">
                                <Copy className="size-5" />
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
                                <p className="text-base font-mono font-medium text-foreground truncate">{result.account.password}</p>
                              </div>
                              <button onClick={() => copyToClipboard(result.account.password)} className="text-primary hover:text-destructive transition-colors shrink-0 p-1">
                                <Copy className="size-5" />
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
                                <p className="text-base font-medium text-foreground truncate">{result.account.profile_name || '-'}</p>
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
                                <p className="text-base font-medium text-foreground truncate">{new Date(result.account.expired_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {(() => {
                        const validCustomFields = customFields.filter(field => {
                          const resolved = resolve(field.value);
                          // Hide if it's empty or still contains placeholder syntax
                          return resolved && !resolved.includes('$$');
                        });
                        
                        if (validCustomFields.length === 0) return null;
                        
                        return (
                          <div className={cn(
                            "grid gap-8",
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
                                    <p className="text-base font-mono font-medium text-foreground truncate">{resolvedValue}</p>
                                  </div>
                                  <button onClick={() => copyToClipboard(resolvedValue)} className="text-primary hover:text-destructive transition-colors shrink-0 p-1">
                                    <Copy className="size-5" />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {showInstruction && result.voucher.product_variant?.copy_template && (
                        <div className="mt-4 p-8 bg-primary/10 rounded-[32px] border border-primary/20 border-l-8 border-l-primary">
                          <p className="text-xs font-black text-primary uppercase tracking-[0.2em] mb-3">Instruksi Penggunaan</p>
                          <p className="text-base text-muted-foreground leading-relaxed font-bold italic whitespace-pre-wrap">{resolve(result.voucher.product_variant.copy_template)}</p>
                        </div>
                      )}

                      {showPortal && accessToken && (
                        <div className="mt-6">
                          <EmailPortal token={accessToken} />
                        </div>
                      )}

                      {result.voucher?.product_variant?.tutorial?.slug && accessToken && (
                        <div className="mt-4 p-6 bg-muted/30 rounded-[32px] flex flex-col md:flex-row items-center justify-between gap-6">
                          <div>
                            <p className="text-xs font-black text-destructive uppercase tracking-[0.2em] mb-1">📖 Panduan Penggunaan</p>
                            <p className="text-sm text-slate-400 font-medium">Ikuti langkah-langkah penggunaan agar akun Anda aman dan awet.</p>
                          </div>
                          <Link
                            href={`/tutorial/${result.voucher.product_variant.tutorial.slug}?token=${accessToken}&tenant=${tenantId || 'master'}`}
                            className="shrink-0 px-8 py-4 bg-background text-foreground hover:bg-primary/100 hover:text-primary-foreground font-black rounded-2xl transition-all flex items-center gap-2 text-sm shadow-lg"
                          >
                            <BookOpen className="size-4" />
                            Lihat Panduan
                          </Link>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <Footer />
    </main>
  )
}
