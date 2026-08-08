'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Monitor, 
  Smartphone, 
  Tv, 
  ChevronDown, 
  ChevronUp, 
  HelpCircle,
  CheckCircle2,
  Copy,
  ExternalLink
} from 'lucide-react'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

interface NetflixLoginGuideProps {
  token: string
  email: string
}

export function NetflixLoginGuide({ token, email }: NetflixLoginGuideProps) {
  const [isHowToLoginOpen, setIsHowToLoginOpen] = useState(false)
  const [selectedDevice, setSelectedDevice] = useState<'mobile' | 'pc' | 'tv' | null>(null)
  const [mobileStep, setMobileStep] = useState<1 | 2>(1)
  const [showMobileError, setShowMobileError] = useState(false)

  const { data: netflixTokenData } = useQuery<{token: string, pcLink: string, mobileLink: string, tvLink: string}>({
    queryKey: ['netflix-token', token],
    queryFn: async () => {
      const cacheKey = `netflix-token-${token}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Date.now() - parsed.timestamp < 12 * 60 * 60 * 1000) {
            return parsed.data;
          }
        } catch (e) {}
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
    enabled: true,
    retry: 2,
  })

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success('Disalin ke clipboard!')
  }

  const handleOpenOtp = () => {
    window.dispatchEvent(new CustomEvent('open-otp-inbox'))
    setTimeout(() => {
      const el = document.getElementById('otp-inbox-section')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
  }

  return (
    <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl overflow-hidden transition-all mb-10">
      <button 
        onClick={() => setIsHowToLoginOpen(!isHowToLoginOpen)}
        className="w-full flex items-center justify-between p-5 hover:bg-amber-500/10 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-500/10 rounded-lg shrink-0">
            <HelpCircle className="size-5 text-amber-500" />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-black text-foreground">Saya belum paham caranya login</h3>
            <p className="text-[10px] text-muted-foreground font-medium">Klik di sini untuk melihat panduan langkah demi langkah</p>
          </div>
        </div>
        {isHowToLoginOpen ? <ChevronUp className="size-5 text-muted-foreground" /> : <ChevronDown className="size-5 text-muted-foreground" />}
      </button>
      
      <AnimatePresence>
        {isHowToLoginOpen && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-5 pb-5 overflow-hidden border-t border-amber-500/10"
          >
            {!selectedDevice ? (
              <div className="pt-4 space-y-3">
                <p className="text-sm font-bold text-center mb-4">Mau login ke device apa?</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <button onClick={() => setSelectedDevice('mobile')} className="flex flex-col items-center gap-2 p-4 bg-background border border-border rounded-xl hover:border-amber-500 hover:bg-amber-500/5 transition-all">
                    <Smartphone className="size-6 text-slate-400" />
                    <span className="text-xs font-black">Mobile HP/TAB/IPAD</span>
                  </button>
                  <button onClick={() => setSelectedDevice('pc')} className="flex flex-col items-center gap-2 p-4 bg-background border border-border rounded-xl hover:border-amber-500 hover:bg-amber-500/5 transition-all">
                    <Monitor className="size-6 text-slate-400" />
                    <span className="text-xs font-black">PC / LAPTOP</span>
                  </button>
                  <button onClick={() => setSelectedDevice('tv')} className="flex flex-col items-center gap-2 p-4 bg-background border border-border rounded-xl hover:border-amber-500 hover:bg-amber-500/5 transition-all">
                    <Tv className="size-6 text-slate-400" />
                    <span className="text-xs font-black">SMART TV</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="pt-4 space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <button onClick={() => { setSelectedDevice(null); setMobileStep(1); setShowMobileError(false); }} className="text-[10px] font-bold text-muted-foreground hover:text-foreground">← Kembali</button>
                  <span className="text-[10px] font-bold text-slate-300">|</span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-amber-500">Panduan {selectedDevice}</span>
                </div>

                {selectedDevice === 'pc' && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium leading-relaxed">
                      Silahkan copy dan paste link dibawah ini di URL browser laptop kalian (pakai Chrome aja)
                    </p>
                    {netflixTokenData?.pcLink ? (
                      <div className="flex flex-col md:flex-row md:items-center gap-3 p-3 bg-background border border-border rounded-xl">
                        <div className="flex items-center gap-2 md:w-32 shrink-0">
                          <Monitor className="size-4 text-slate-400" />
                          <span className="text-xs font-black">PC Link</span>
                        </div>
                        <div className="flex-grow flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2 border border-border overflow-hidden">
                          <span className="text-[10px] font-mono text-slate-500 truncate">{netflixTokenData.pcLink}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 mt-2 md:mt-0">
                          <button onClick={() => copyToClipboard(netflixTokenData.pcLink)} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-background border border-border hover:border-primary hover:bg-primary/5 text-foreground hover:text-primary rounded-lg text-[10px] font-black uppercase transition-all">
                            <Copy className="size-3" /> Copy
                          </button>
                          <a href={netflixTokenData.pcLink} target="_blank" rel="noopener noreferrer" className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm rounded-lg text-[10px] font-black uppercase transition-all">
                            <ExternalLink className="size-3" /> Buka
                          </a>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-destructive">Data link belum tersedia.</div>
                    )}
                    <p className="text-sm font-bold text-green-600 bg-green-50 p-3 rounded-lg flex items-center gap-2">
                      <CheckCircle2 className="size-4" /> Otomatis sudah login!
                    </p>
                  </div>
                )}

                {selectedDevice === 'tv' && (
                  <div className="space-y-4">
                    <p className="text-sm font-medium leading-relaxed">
                      Silahkan buka link dibawah ini:
                    </p>
                    {netflixTokenData?.tvLink ? (
                      <div className="flex flex-col md:flex-row md:items-center gap-3 p-3 bg-background border border-border rounded-xl">
                        <div className="flex items-center gap-2 md:w-32 shrink-0">
                          <Tv className="size-4 text-slate-400" />
                          <span className="text-xs font-black">TV Link</span>
                        </div>
                        <div className="flex-grow flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2 border border-border overflow-hidden">
                          <span className="text-[10px] font-mono text-slate-500 truncate">{netflixTokenData.tvLink}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 mt-2 md:mt-0">
                          <button onClick={() => copyToClipboard(netflixTokenData.tvLink)} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-background border border-border hover:border-primary hover:bg-primary/5 text-foreground hover:text-primary rounded-lg text-[10px] font-black uppercase transition-all">
                            <Copy className="size-3" /> Copy
                          </button>
                          <a href={netflixTokenData.tvLink} target="_blank" rel="noopener noreferrer" className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm rounded-lg text-[10px] font-black uppercase transition-all">
                            <ExternalLink className="size-3" /> Buka
                          </a>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-destructive">Data link belum tersedia.</div>
                    )}
                    <p className="text-sm font-medium leading-relaxed mt-2">
                      Lalu masukin 8 digit kode TV anda lalu klik lanjutkan, maka akan otomatis login di TV kalian.
                    </p>
                  </div>
                )}

                {selectedDevice === 'mobile' && (
                  <div className="space-y-4">
                    {mobileStep === 1 && (
                      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                        <p className="text-sm font-medium leading-relaxed">
                          <strong>1.</strong> Silahkan copy email dibawah ini lalu paste ke halaman login Netflix.
                        </p>
                        <div className="flex items-center justify-between p-4 bg-muted/50 border border-border rounded-xl">
                          <span className="text-sm font-mono font-bold">{email}</span>
                          <button onClick={() => copyToClipboard(email)} className="p-2 hover:bg-primary/10 rounded-lg transition-colors">
                            <Copy className="size-4 text-slate-400" />
                          </button>
                        </div>
                        <button 
                          onClick={() => setMobileStep(2)}
                          className="w-full py-3 bg-amber-500 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-amber-600 transition-all"
                        >
                          Oke Min Sudah Saya Lakukan
                        </button>
                      </motion.div>
                    )}

                    {mobileStep === 2 && (
                      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                        <p className="text-sm font-medium leading-relaxed">
                          <strong>2.</strong> Setelah itu kalian klik tombol lanjutkan, maka akan muncul 4 kotak untuk memasukan kode.
                        </p>
                        
                        {!showMobileError ? (
                          <div className="flex flex-col gap-3 mt-4">
                            <button 
                              onClick={handleOpenOtp}
                              className="w-full py-3 bg-primary text-primary-foreground rounded-xl text-xs font-black uppercase tracking-widest hover:bg-primary/90 transition-all shadow-sm"
                            >
                              Okey min berapa kode nya?
                            </button>
                            <button 
                              onClick={() => setShowMobileError(true)}
                              className="w-full py-3 bg-destructive/5 text-destructive border border-destructive/20 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-destructive/10 transition-all"
                            >
                              Terjadi kesalahan min
                            </button>
                          </div>
                        ) : (
                          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                            {netflixTokenData?.mobileLink ? (
                              <div className="flex flex-col md:flex-row md:items-center gap-3 p-3 bg-background border border-border rounded-xl">
                                <div className="flex items-center gap-2 md:w-32 shrink-0">
                                  <Smartphone className="size-4 text-slate-400" />
                                  <span className="text-xs font-black">Mobile Link</span>
                                </div>
                                <div className="flex-grow flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2 border border-border overflow-hidden">
                                  <span className="text-[10px] font-mono text-slate-500 truncate">{netflixTokenData.mobileLink}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0 mt-2 md:mt-0">
                                  <button onClick={() => copyToClipboard(netflixTokenData.mobileLink)} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-background border border-border hover:border-primary hover:bg-primary/5 text-foreground hover:text-primary rounded-lg text-[10px] font-black uppercase transition-all">
                                    <Copy className="size-3" /> Copy
                                  </button>
                                  <a href={netflixTokenData.mobileLink} target="_blank" rel="noopener noreferrer" className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm rounded-lg text-[10px] font-black uppercase transition-all">
                                    <ExternalLink className="size-3" /> Buka
                                  </a>
                                </div>
                              </div>
                            ) : (
                              <div className="text-xs text-destructive">Data link belum tersedia.</div>
                            )}
                            <p className="text-xs font-medium leading-relaxed text-slate-600 bg-white p-3 rounded-lg border border-slate-100">
                              Silahkan Copy dan paste link diatas ke URL browser web kalian (Chrome atau Safari) lalu klik <strong>Open in app</strong> lalu klik <strong>Continue</strong> otomatis login ke Netflix.
                            </p>
                          </motion.div>
                        )}
                      </motion.div>
                    )}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
