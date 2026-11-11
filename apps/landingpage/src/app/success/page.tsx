'use client'

import { useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { Copy, Home, MessageSquare, ArrowRight, Loader2, Zap, BadgeCheck } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Suspense, useState, useEffect } from 'react'
import { Navbar } from '@/components/navbar'
import { Footer } from '@/components/footer'
import { api } from '@/lib/api'
import { AlertCircle } from 'lucide-react'
import { useNotification } from '@/hooks/use-notification'
import { useSettings } from '@/hooks/use-settings'
import { useTenant } from '@/hooks/use-tenant'

function SuccessContent() {
  const { tenantId } = useTenant()
  const { data: settings } = useSettings(tenantId || '')
  const [whatsappNumber, setWhatsappNumber] = useState('6285189307255')

  useEffect(() => {
    if (settings?.whatsapp_number) {
      setWhatsappNumber(settings.whatsapp_number)
    }
  }, [settings?.whatsapp_number])

  const searchParams = useSearchParams()
  const [code, setCode] = useState<string | null>(searchParams.get('voucher') || searchParams.get('code'))
  const [voucherCodes, setVoucherCodes] = useState<string[]>([])
  const [buyerWhatsapp, setBuyerWhatsapp] = useState<string | null>(null)
  const orderId = searchParams.get('order_id')
  const [voucherData, setVoucherData] = useState<any>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [isClaiming, setIsClaiming] = useState(false)
  const { addNotification, removePendingByOrderId, markVoucherAsClaimed } = useNotification()

  // Polling for payment status if only orderId is present
  useEffect(() => {
    if (orderId && !code) {
      setIsChecking(true)

      // Check immediately on mount first
      const checkStatus = async () => {
        try {
          const res = await api.get(`/public/payment/status/${orderId}`)
          if (res.data.payment_status === 'PAID') {
            const codes: string[] = res.data.voucher_codes || (res.data.voucher_code ? [res.data.voucher_code] : [])
            setVoucherCodes(codes)
            setCode(codes[0] || res.data.voucher_code)
            if (res.data.buyer_whatsapp) setBuyerWhatsapp(res.data.buyer_whatsapp)
            setIsChecking(false)
            return true
          }
        } catch (err) {
          console.error('Gagal mengecek status pembayaran:', err)
        }
        return false
      }

      let interval: NodeJS.Timeout

      checkStatus().then((done) => {
        if (!done) {
          // If not confirmed yet, poll every 1 second
          interval = setInterval(async () => {
            const confirmed = await checkStatus()
            if (confirmed) {
              clearInterval(interval)
              toast.success('Pembayaran terkonfirmasi!')
            }
          }, 1000)
        }
      })

      return () => clearInterval(interval)
    }
  }, [orderId, code])

  // Fetch voucher details once code is available
  useEffect(() => {
    if (code) {
      api.get(`/public/voucher/${code}`)
        .then(res => {
          const voucher = res.data.voucher
          setVoucherData(voucher)
          if (voucher?.buyer_whatsapp) {
            setBuyerWhatsapp(voucher.buyer_whatsapp)
          }
          
          // 1. Bersihkan dulu notifikasi pending yang berkaitan
          const targetOrderId = orderId || voucher.payment_id;
          if (targetOrderId) {
            removePendingByOrderId(targetOrderId);
          }

          const productName = voucher.product_variant ? `${voucher.product_variant.product?.name || 'Produk'} - ${voucher.product_variant.name}` : 'Produk';
          
          // 2. Tambahkan notifikasi sukses
          addNotification({
            type: 'success',
            title: 'Pembayaran Berhasil!',
            message: `Voucher untuk ${productName} siap digunakan.`,
            data: {
              orderId: targetOrderId || undefined,
              productName: productName,
              voucherCode: code,
              price: voucher.price
            }
          });
        })
        .catch(err => console.error('Gagal mengambil data voucher:', err))
    }
  }, [code, orderId])

  const copyCode = () => {
    if (code) {
      navigator.clipboard.writeText(code)
      toast.success('Kode voucher disalin!')
    }
  }

  const handleClaim = async () => {
    if (!code) return
    setIsClaiming(true)
    try {
      await api.post('/public/voucher/redeem', { voucher_code: code })
      markVoucherAsClaimed(code)
      toast.success('Voucher berhasil diklaim! Membuka halaman akun...')
      // Open redeem page in a new tab
      window.open(`/redeem?code=${code}`, '_blank')
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Gagal mengklaim voucher. Coba gunakan halaman Redeem.')
      setIsClaiming(false)
    }
  }

  return (
    <main className="min-h-screen flex flex-col pt-32 bg-muted/50">
      <Navbar />
      
      <div className="container mx-auto max-w-2xl px-6 flex-grow flex flex-col justify-center mb-32">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-background p-10 md:p-14 text-center rounded-3xl border border-border shadow-2xl relative overflow-hidden"
        >
          {/* Simple Verified Badge */}
          <div className="flex justify-center mb-6">
            <BadgeCheck className="size-16 text-primary" fill="currentColor" stroke="white" />
          </div>
          
          <h1 className="text-3xl md:text-4xl font-black mb-8 text-foreground tracking-tight text-center">
            Pembayaran<br/>Berhasil
          </h1>

          <hr className="border-border mb-8" />

          {/* Voucher Code Section */}
          <div className="flex flex-col items-center justify-center mb-6">
            <p className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-3">
              {voucherCodes.length > 1 ? `Daftar Kode Voucher (${voucherCodes.length} Akun)` : 'Kode Voucher'}
            </p>

            {voucherCodes.length > 1 ? (
              <>
                <div className="w-full space-y-3 mb-6">
                  {voucherCodes.map((vCode, idx) => (
                    <div
                      key={vCode}
                      className="flex items-center justify-between p-3.5 bg-muted/40 rounded-2xl border border-border"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-primary/10 text-primary">
                          Akun #{idx + 1}
                        </span>
                        <span className="text-lg md:text-xl font-black text-primary tracking-tight">
                          {vCode}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(vCode)
                            toast.success(`Kode voucher #${idx + 1} disalin!`)
                          }}
                          className="p-2 text-primary hover:bg-primary/10 rounded-xl transition-all duration-300 active:scale-95 flex items-center justify-center"
                          title="Salin Voucher"
                        >
                          <Copy className="size-4" />
                        </button>
                        <a
                          href={`/redeem?code=${vCode}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl text-xs flex items-center gap-1 shadow-sm transition-all"
                        >
                          <Zap className="size-3" /> Klaim
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
                {/* Klaim Semua button — opens history page in new tab, pre-filled with buyer phone */}
                <button
                  type="button"
                  onClick={() => {
                    const targetUrl = buyerWhatsapp ? `/history?identifier=${encodeURIComponent(buyerWhatsapp)}` : '/history'
                    window.open(targetUrl, '_blank')
                  }}
                  className="w-full mb-6 px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-2xl text-sm flex items-center justify-center gap-2 transition-all duration-300 shadow-md active:scale-95"
                >
                  <ArrowRight className="size-4" /> Klaim Semua Akun di Riwayat
                </button>
              </>
            ) : (
              <div className="flex items-center gap-3 mb-6">
                <span className="text-2xl md:text-3xl font-black text-primary tracking-tight">
                  {code || (isChecking ? 'MENGECEK...' : 'VC-XXXXXXXX')}
                </span>
                <button 
                  onClick={copyCode}
                  className="p-2 text-primary hover:bg-primary/10 rounded-xl transition-all duration-300 active:scale-95 flex items-center justify-center"
                  title="Salin Voucher"
                >
                  <Copy className="size-5" />
                </button>
              </div>
            )}
            
            {/* Primary: Claim directly from this page for single voucher */}
            {voucherCodes.length <= 1 && code && voucherData?.status === 'UNUSED' && (
              <button
                onClick={handleClaim}
                disabled={isClaiming}
                className="px-8 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl transition-all duration-300 shadow-md active:scale-95 flex items-center justify-center gap-2 text-sm"
              >
                {isClaiming ? (
                  <><Loader2 className="size-4 animate-spin" /> Memproses...</>
                ) : (
                  <><Zap className="size-4" /> Claim Sekarang</>
                )}
              </button>
            )}
          </div>

          <p className="text-sm text-slate-500 mb-10 font-medium px-4 text-center">
            simpan kode voucher ini untuk Akses Akun dan Kode OTP Email
          </p>

          {voucherData?.expired_at && (
            <div className="mb-6 p-4 bg-orange-50 border border-orange-200 rounded-xl flex items-start gap-3 text-left">
              <AlertCircle className="size-5 text-orange-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-orange-600 uppercase tracking-widest mb-1">Peringatan Penting</p>
                <p className="text-xs text-orange-800 font-medium leading-relaxed">
                  Segera klaim voucher Anda sebelum <span className="font-bold">{new Date(voucherData.expired_at).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' })}</span> agar tidak hangus.
                </p>
              </div>
            </div>
          )}

          <div className="pt-6 border-t border-border flex flex-col items-center justify-center gap-4">
            <Link
              href="/"
              className="text-sm text-slate-400 font-bold hover:text-foreground transition-all flex items-center gap-2"
            >
              <Home className="size-4" />
              Kembali ke Beranda
            </Link>
            
            <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
              <span>Butuh bantuan?</span>
              <Link href={`https://wa.me/${whatsappNumber}`} className="text-primary font-bold hover:underline flex items-center gap-1">
                <MessageSquare className="size-3" />
                Support WhatsApp
              </Link>
            </div>
          </div>
        </motion.div>
      </div>

      <Footer />
    </main>
  )
}

export default function SuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="size-12 text-primary animate-spin" />
      </div>
    }>
      <SuccessContent />
    </Suspense>
  )
}
