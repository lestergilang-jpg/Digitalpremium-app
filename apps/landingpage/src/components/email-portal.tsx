'use client'

import { useQuery } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { 
  Mail, 
  RefreshCw, 
  AlertCircle,
  Calendar,
  Copy,
  ExternalLink,
  ShieldAlert,
  Inbox,
  Monitor,
  Smartphone,
  Tv,
  Link2,
  KeyRound,
  ChevronDown,
  ChevronUp,
  CheckCircle2
} from 'lucide-react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'

interface Message {
  id: string
  subject: string
  email_date: string
  parsed_context: string
  parsed_data: string
}

interface PortalData {
  account: {
    email: string
    profile_name: string
    expired_at: string
    product_name?: string
  }
  messages: Message[]
  limit: {
    remaining: number
    total: number
  }
}

interface EmailPortalProps {
  token: string
}

export function EmailPortal({ token }: EmailPortalProps) {
  const [countdown, setCountdown] = useState(30)
  const [isNetflixLinksOpen, setIsNetflixLinksOpen] = useState(false)
  const [isOtpInboxOpen, setIsOtpInboxOpen] = useState(true)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<PortalData>({
    queryKey: ['portal-data', token],
    queryFn: async () => {
      const { data } = await api.get(`/public/email-access/${token}`)
      return data
    },
    refetchInterval: 30000,
    retry: false,
  })

  const isNetflix = data?.account?.product_name?.toLowerCase().includes('netflix')

  const { data: netflixTokenData, isLoading: isLoadingToken, isError: isErrorToken, refetch: refetchToken, isFetching: isFetchingToken } = useQuery<{token: string, pcLink: string, mobileLink: string, tvLink: string}>({
    queryKey: ['netflix-token', token],
    queryFn: async () => {
      const cacheKey = `netflix-token-${token}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          // Cache for 12 hours
          if (Date.now() - parsed.timestamp < 12 * 60 * 60 * 1000) {
            return parsed.data;
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const { data: initData } = await api.get(`/public/email-access/${token}/netflix-token`)
      
      let finalResult = initData;
      if (initData?.status === 'processing') {
        const taskId = initData.taskId;
        while (true) {
          await new Promise((r) => setTimeout(r, 2000));
          const { data: statusData } = await api.get(`/public/task-status/${taskId}`);
          if (statusData.status === 'COMPLETED') {
            finalResult = statusData.result;
            break;
          } else if (statusData.status === 'FAILED') {
            throw new Error(statusData.error_message || 'Gagal memproses token Netflix dari Bot');
          }
        }
      }

      const nftoken = finalResult?.token;
      if (!nftoken) return finalResult;

      const result = {
        token: nftoken,
        pcLink: finalResult.pcLink || `https://www.netflix.com/login?nftoken=${nftoken}`,
        mobileLink: finalResult.mobileLink || `https://www.netflix.com/unsupported?nftoken=${nftoken}`,
        tvLink: finalResult.tvLink || `https://www.netflix.com/tv9?nftoken=${nftoken}`,
      };
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: result }));
      return result;
    },
    enabled: !!isNetflix,
    retry: 2,
  })

  useEffect(() => {
    if (isFetching) {
      setCountdown(30)
      return
    }

    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) return 30
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [isFetching])

  useEffect(() => {
    const handleOpenOtp = () => setIsOtpInboxOpen(true)
    window.addEventListener('open-otp-inbox', handleOpenOtp as EventListener)
    return () => window.removeEventListener('open-otp-inbox', handleOpenOtp as EventListener)
  }, [])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success('Disalin ke clipboard!')
  }

  const formatDateTime = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return new Intl.DateTimeFormat('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
      }).format(date)
    } catch (e) {
      return dateStr
    }
  }

  if (isLoading) {
    return (
      <div className="w-full p-12 bg-muted/50 border border-border rounded-[32px] flex flex-col items-center justify-center gap-4">
        <RefreshCw className="size-8 text-primary animate-spin" />
        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">Menghubungkan ke Portal...</p>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="w-full p-12 bg-destructive/10 border border-red-100 rounded-[32px] flex flex-col items-center text-center gap-4">
        <div className="p-4 bg-red-100 rounded-full">
          <ShieldAlert className="size-8 text-red-500" />
        </div>
        <div>
          <h4 className="text-lg font-black text-red-600 mb-1">Gagal Memuat Portal</h4>
          <p className="text-sm text-red-400 font-medium">{(error as any)?.message || 'Terjadi kesalahan sistem'}</p>
        </div>
        <button 
          onClick={() => refetch()}
          className="px-6 py-2 bg-destructive/100 text-white font-bold rounded-xl text-xs uppercase tracking-widest hover:bg-red-600 transition-all"
        >
          Coba Lagi
        </button>
      </div>
    )
  }

  // Filter messages from the last 15 minutes like in the dashboard
  const messages = (data?.messages || []).filter((msg) => {
    const emailDate = new Date(msg.email_date)
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000)
    return emailDate >= fifteenMinutesAgo
  })

  return (
    <div className="space-y-6">
      {/* Netflix Instant Login Links */}
      {isNetflix && (
        <div className="bg-primary/5 border border-primary/20 rounded-2xl overflow-hidden transition-all">
          <button 
            onClick={() => setIsNetflixLinksOpen(!isNetflixLinksOpen)}
            className="w-full flex items-center justify-between p-5 hover:bg-primary/10 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg shrink-0">
                <KeyRound className="size-5 text-primary" />
              </div>
              <div className="text-left">
                <h3 className="text-sm font-black text-foreground">Tombol Akses Login Instan</h3>
                <p className="text-[10px] text-muted-foreground font-medium">Pilih perangkat Anda dan klik Buka untuk login otomatis</p>
              </div>
            </div>
            {isNetflixLinksOpen ? <ChevronUp className="size-5 text-muted-foreground" /> : <ChevronDown className="size-5 text-muted-foreground" />}
          </button>
          
          <AnimatePresence>
            {isNetflixLinksOpen && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="px-5 pb-5 overflow-hidden"
              >
                {isLoadingToken ? (
                  <div className="flex flex-col items-center justify-center p-6 bg-background rounded-xl border border-border">
                    <RefreshCw className="size-5 text-primary animate-spin mb-3" />
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Mengambil Token Akses...</p>
                  </div>
                ) : isErrorToken || !netflixTokenData?.token ? (
                  <div className="flex flex-col items-center justify-center p-6 bg-destructive/5 rounded-xl border border-destructive/20 text-center">
                    <ShieldAlert className="size-5 text-destructive mb-2" />
                    <p className="text-xs font-bold text-destructive mb-3">Gagal memuat token dari server bot.</p>
                    <button 
                      onClick={() => {
                        localStorage.removeItem(`netflix-token-${token}`);
                        refetchToken();
                      }} 
                      className="text-[10px] bg-destructive/10 text-destructive font-black px-4 py-2 rounded-lg uppercase tracking-widest hover:bg-destructive/20 transition-all"
                    >
                      Coba Lagi
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3 pt-2">
                    <div className="flex justify-end mb-1">
                      <button 
                        onClick={() => {
                          localStorage.removeItem(`netflix-token-${token}`);
                          refetchToken();
                          toast.info('Menyegarkan token...');
                        }}
                        disabled={isFetchingToken}
                        className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-50"
                      >
                        <RefreshCw className={`size-3 ${isFetchingToken ? 'animate-spin' : ''}`} />
                        Segarkan Token
                      </button>
                    </div>
                    {[
                      { label: 'PC Link', icon: Monitor, url: netflixTokenData.pcLink },
                      { label: 'Mobile Link', icon: Smartphone, url: netflixTokenData.mobileLink },
                      { label: 'TV Link', icon: Tv, url: netflixTokenData.tvLink },
                    ].map((link, idx) => (
                      <div key={idx} className="flex flex-col md:flex-row md:items-center gap-3 p-3 bg-background border border-border rounded-xl hover:border-primary/30 transition-all">
                        <div className="flex items-center gap-2 md:w-32 shrink-0">
                          <link.icon className="size-4 text-slate-400" />
                          <span className="text-xs font-black text-foreground">{link.label}</span>
                        </div>
                        <div className="flex-grow flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2 border border-border overflow-hidden">
                          <span className="text-[10px] font-mono text-slate-500 truncate">{link.url}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 mt-2 md:mt-0">
                          <button 
                            onClick={() => copyToClipboard(link.url)}
                            className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-background border border-border hover:border-primary hover:bg-primary/5 text-foreground hover:text-primary rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                          >
                            <Copy className="size-3" /> Copy
                          </button>
                          <a 
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                          >
                            <ExternalLink className="size-3" /> Buka
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <div id="otp-inbox-section" className="bg-primary/5 border border-primary/20 rounded-2xl overflow-hidden transition-all mt-4">
        <button 
          onClick={() => setIsOtpInboxOpen(!isOtpInboxOpen)}
          className="w-full flex items-center justify-between p-5 hover:bg-primary/10 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg shrink-0">
              <Mail className="size-5 text-primary" />
            </div>
            <div className="text-left">
              <h3 className="text-sm font-black text-foreground">Email OTP Inbox</h3>
              <p className="text-[10px] text-muted-foreground font-medium">Daftar pesan kode OTP yang masuk</p>
            </div>
          </div>
          {isOtpInboxOpen ? <ChevronUp className="size-5 text-muted-foreground" /> : <ChevronDown className="size-5 text-muted-foreground" />}
        </button>

        <AnimatePresence>
          {isOtpInboxOpen && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-5 pb-5 overflow-hidden border-t border-primary/10"
            >
              <div className="space-y-4 pt-4">

      {/* Info Warning */}
      <div className="bg-destructive/10 border border-destructive/20 rounded-2xl p-5 flex items-start gap-4">
        <div className="bg-background p-2 rounded-lg shrink-0">
          <AlertCircle className="size-5 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-black text-destructive uppercase tracking-widest">Peringatan Penting</p>
          <p className="text-xs text-muted-foreground font-medium leading-relaxed">
            Setelah request kode/link dari aplikasi, tunggu <strong>1 menit</strong>. Pesan akan muncul otomatis di bawah.
          </p>
          <p className="text-[10px] text-muted-foreground font-bold flex items-center gap-1.5 pt-1">
            <RefreshCw className={`size-3 ${countdown < 5 ? 'animate-spin text-destructive' : ''}`} />
            Update dalam {countdown} detik...
          </p>
        </div>
      </div>

      {/* Messages List */}
      <div className="space-y-4">
        {messages.length === 0 ? (
          <div className="p-16 border-2 border-dashed border-border rounded-[32px] flex flex-col items-center text-center gap-4 bg-background">
            <div className="p-4 bg-muted/50 rounded-full shadow-sm">
              <Inbox className="size-8 text-slate-300" />
            </div>
            <div className="max-w-xs">
              <p className="text-sm font-black text-foreground mb-1">Belum Ada Pesan</p>
              <p className="text-xs text-slate-400 font-medium leading-relaxed">Pesan OTP atau link reset akan otomatis muncul di sini setelah Anda request dari aplikasi/TV.</p>
            </div>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {messages.map((msg, idx) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className="bg-background border border-border rounded-2xl p-5 hover:border-primary transition-all group relative overflow-hidden shadow-sm"
              >
                <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                  <div className="space-y-2 flex-grow">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase tracking-widest rounded-md border border-primary/20">
                        {msg.parsed_context.replace('NETFLIX_', '').replace(/_/g, ' ')}
                      </span>
                      <span className="text-[10px] text-slate-400 font-bold flex items-center gap-1">
                        <Calendar className="size-3" />
                        {formatDateTime(msg.email_date)}
                      </span>
                    </div>
                    <h4 className="text-base font-black text-foreground">{msg.subject}</h4>
                  </div>
                  
                  {msg.parsed_data.startsWith('http') && (
                    <a 
                      href={msg.parsed_data}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-muted/50 hover:bg-primary hover:text-white text-foreground text-[10px] font-black uppercase tracking-widest rounded-lg border border-border transition-all flex items-center gap-2 shrink-0"
                    >
                      Buka Link <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>

                <div className="mt-4 p-4 bg-muted/50 rounded-xl border border-border flex items-center justify-between gap-4">
                  <div className="overflow-hidden">
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Kode / Data</p>
                    <p className="text-xl font-mono font-black text-primary truncate leading-none">
                      {msg.parsed_data}
                    </p>
                  </div>
                  <button 
                    onClick={() => copyToClipboard(msg.parsed_data)}
                    className="p-2 hover:bg-primary/10 text-slate-400 hover:text-primary transition-all rounded-lg"
                  >
                    <Copy className="size-5" />
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-center gap-2 pt-4 opacity-30 grayscale pointer-events-none">
        <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic">Powered by Volve Engine v2</span>
      </div>
    </div>
  )
}
