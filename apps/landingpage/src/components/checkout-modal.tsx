'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ShieldCheck, Loader2, AlertCircle, Shield, ReceiptText } from 'lucide-react'
import { Product, ProductVariant } from '@/hooks/use-products'
import { api } from '@/lib/api'
import { QrisModal } from './qris-modal'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/format'
import { useNotification } from '@/hooks/use-notification'
import { cn } from '@/lib/utils'

declare global {
  interface Window {
    loadJokulCheckout: (url: string) => void;
  }
}

interface CheckoutModalProps {
  isOpen: boolean
  onClose: () => void
  product: Product | null
  variant: ProductVariant | null
  initialData?: any
}

export function CheckoutModal({ isOpen, onClose, product, variant, initialData }: CheckoutModalProps) {
  const [step, setStep] = useState(1)
  const [formData, setFormData] = useState({ name: '', email: '', whatsapp: '' })
  const [isLoading, setIsLoading] = useState(false)
  const [isShaking, setIsShaking] = useState(false)
  const [paymentUrl, setPaymentUrl] = useState<string | null>(initialData?.paymentUrl || null)
  const [promoCode, setPromoCode] = useState(initialData?.promoCode || '')
  const [promoData, setPromoData] = useState<{ id: string, discount_amount: number } | null>(null)
  const [isPromoLoading, setIsPromoLoading] = useState(false)
  const [promoError, setPromoError] = useState('')
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [qrisData, setQrisData] = useState<{ isOpen: boolean; qrString: string; orderId: string; amount: number; productName: string } | null>(null)
  const [durationMultiplier, setDurationMultiplier] = useState(1)
  const [quantity, setQuantity] = useState(1)
  const { addNotification } = useNotification()

  const isDailyVariant = Boolean(
    variant?.name?.toLowerCase().includes('harian') ||
    (variant?.duration ? Number(variant.duration) <= 24 * 60 * 60 * 1000 : false)
  );
  const currentMultiplier = isDailyVariant ? durationMultiplier : 1;
  const currentQuantity = Math.max(1, Math.min(5, quantity));
  const rawSubtotal = (variant?.price || 0) * currentMultiplier * currentQuantity;
  const finalAmount = Math.max(0, rawSubtotal - (promoData?.discount_amount || 0));
  
  // Handle initial data population and local storage
  useEffect(() => {
    if (isOpen) {
      if (initialData?.formData) {
        setFormData(initialData.formData);
      } else {
        const saved = localStorage.getItem('checkout_buyer_info');
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            setFormData(prev => ({
              ...prev,
              name: parsed.name || prev.name,
              email: parsed.email || prev.email,
              whatsapp: parsed.whatsapp || prev.whatsapp
            }));
          } catch (e) {
            console.error('Failed to parse saved buyer info', e);
          }
        }
      }

      if (initialData?.paymentUrl) {
        setPaymentUrl(initialData.paymentUrl);
        setStep(2);
      }
    }
  }, [isOpen, initialData])

  // Reset state when variant changes or modal opens
  useEffect(() => {
    if (isOpen && !initialData) {
      setPromoCode('')
      setPromoData(null)
      setPromoError('')
      setDurationMultiplier(1)
      setStep(1)
    }
  }, [variant?.id, isOpen, initialData])


  const shakeAnimation = {
    x: [0, -10, 10, -10, 10, 0],
    transition: { duration: 0.4 }
  }

  const handleStep1Submit = (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!formData.name || !formData.email || !formData.whatsapp) {
      setIsShaking(true)
      toast.error('Silahkan isi form terlebih dahulu', {
        position: 'top-center',
        className: 'font-bold uppercase text-[10px] tracking-widest'
      })
      setTimeout(() => setIsShaking(false), 500)
      return
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      setIsShaking(true)
      toast.error('Mohon isi email dengan benar', {
        position: 'top-center',
        className: 'font-bold uppercase text-[10px] tracking-widest'
      })
      setTimeout(() => setIsShaking(false), 500)
      return
    }

    if (!formData.whatsapp.startsWith('08') && !formData.whatsapp.startsWith('62')) {
      setIsShaking(true)
      toast.error('Nomor WhatsApp harus diawali 08 atau 62', {
        position: 'top-center',
        className: 'font-bold uppercase text-[10px] tracking-widest'
      })
      setTimeout(() => setIsShaking(false), 500)
      return
    }

    localStorage.setItem('checkout_buyer_info', JSON.stringify({
      name: formData.name,
      email: formData.email,
      whatsapp: formData.whatsapp
    }));

    setStep(2)
  }

  const handleValidatePromo = async () => {
    if (!promoCode || !variant) return
    
    setIsPromoLoading(true)
    setPromoError('')
    setPromoData(null)
    
    try {
      const { data } = await api.post('/public/promo/validate', {
        code: promoCode,
        total_purchase: rawSubtotal,
        product_variant_id: variant.id
      })
      setPromoData(data)
      toast.success('Kode promo berhasil dipasang!', {
        position: 'top-center',
        className: 'font-bold uppercase text-[10px] tracking-widest'
      })
    } catch (error: any) {
      setPromoError(error.response?.data?.message || 'Kode promo tidak valid')
      toast.error(error.response?.data?.message || 'Kode promo tidak valid', {
        position: 'top-center',
        className: 'font-bold uppercase text-[10px] tracking-widest'
      })
    } finally {
      setIsPromoLoading(false)
    }
  }

  const handleFinalCheckout = async () => {
    if (!product || !variant) return

    if (paymentUrl) {
      setIsLoading(true);
      if (window.loadJokulCheckout) {
        window.loadJokulCheckout(paymentUrl)
      } else {
        window.location.href = paymentUrl
      }
      return;
    }

    setIsLoading(true)
    
    const finalVariantId = variant.id;
    const finalPromoCode = (promoData && promoCode) ? promoCode : undefined;

    try {
      let displayName = `${product.name} - ${variant.name}`;
      if (currentMultiplier > 1) displayName += ` (${currentMultiplier} Hari)`;
      if (currentQuantity > 1) displayName += ` x${currentQuantity} Akun`;

      const { data } = await api.post(`/public/payment/create?t=${Date.now()}`, {
        product_variant_id: finalVariantId,
        buyer_name: formData.name,
        buyer_email: formData.email,
        buyer_whatsapp: formData.whatsapp,
        promo_code: finalPromoCode,
        duration_multiplier: currentMultiplier,
        quantity: currentQuantity,
      })

      if (data.qris_string) {
        setQrisData({
          isOpen: true,
          qrString: data.qris_string,
          orderId: data.order_id,
          amount: finalAmount,
          productName: displayName
        });
        setIsLoading(false);
      } else if (data.payment_url) {
        addNotification({
          type: 'pending',
          title: 'Pembayaran Tertunda',
          message: `Segera selesaikan pembayaran untuk ${displayName}`,
          data: {
            orderId: data.order_id, 
            productId: product.id,
            variantId: variant.id,
            productName: product.name,
            variantName: currentMultiplier > 1 ? `${variant.name} (${currentMultiplier} Hari)` : variant.name,
            price: finalAmount,
            paymentUrl: data.payment_url,
            formData: formData,
            promoCode: finalPromoCode,
            durationMultiplier: currentMultiplier,
          }
        });

        if (window.loadJokulCheckout) {
          window.loadJokulCheckout(data.payment_url)
        } else {
          window.location.href = data.payment_url
        }
      } else {
        toast.error('Gagal mendapatkan link pembayaran')
        setIsLoading(false);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Gagal membuat pesanan')
      setIsLoading(false);
    }
  }

  const handleClose = () => {
    if (step === 2 && !isLoading) {
      setShowCloseConfirm(true)
      return
    }

    window.location.reload()
  }

  return (
    <>
    <AnimatePresence>
      {isOpen && (
        <div key="modal-portal" className="fixed inset-0 z-[200] flex items-center justify-center p-4 md:p-6 overflow-y-auto">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-primary/40 backdrop-blur-md"
          />
          
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className={`relative bg-background w-full rounded-[2rem] shadow-2xl overflow-hidden flex flex-col max-h-[95vh] transition-all duration-300 ${step === 1 ? 'max-w-6xl' : 'max-w-md'}`}
          >
            <div className="p-6 md:px-12 border-b border-border flex items-center justify-between sticky top-0 bg-background z-20 rounded-t-[2rem]">
              <div className="flex items-center gap-3">
                <div className="bg-primary p-2 rounded-lg">
                  {step === 1 ? (
                    <ReceiptText className="size-5 text-primary-foreground" />
                  ) : (
                    <ShieldCheck className="size-5 text-primary-foreground" />
                  )}
                </div>
                <h2 className="text-xl font-semibold text-foreground">
                  {step === 1 ? 'Detail Pesanan' : 'Pembayaran Aman'}
                </h2>
              </div>
              <button onClick={handleClose} className="text-slate-400 hover:text-foreground transition-colors p-2">
                <X className="size-6" />
              </button>
            </div>

            <div className="flex-grow overflow-y-auto">
              <AnimatePresence mode="wait">
                {step === 1 ? (
                  <motion.div 
                    key="step1"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="p-6 md:p-12"
                  >
                    <div className="grid grid-cols-1 lg:grid-cols-5 gap-12 lg:gap-16">
                      <motion.div 
                        animate={isShaking ? shakeAnimation : {}}
                        className="lg:col-span-3 space-y-6"
                      >
                        <div className="space-y-8">
                          <h3 className="text-xl font-medium text-foreground">Data Pemesan</h3>
                          
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <label className="text-sm font-semibold text-slate-700 ml-1">
                                Nama Lengkap
                              </label>
                              <input 
                                type="text"
                                className="w-full bg-background border-2 border-border rounded-2xl py-4 px-5 text-foreground focus:outline-none focus:border-primary focus:bg-background transition-all font-medium placeholder:text-slate-400 text-base"
                                placeholder="Masukkan nama Anda"
                                value={formData.name}
                                onChange={e => setFormData({...formData, name: e.target.value})}
                              />
                            </div>

                            <div className="space-y-2">
                              <label className="text-sm font-semibold text-slate-700 ml-1">
                                Alamat Email
                              </label>
                              <input 
                                type="email"
                                className="w-full bg-background border-2 border-border rounded-2xl py-4 px-5 text-foreground focus:outline-none focus:border-primary focus:bg-background transition-all font-medium placeholder:text-slate-400 text-base"
                                placeholder="email@contoh.com (Untuk kirim kode)"
                                value={formData.email}
                                onChange={e => setFormData({...formData, email: e.target.value})}
                              />
                            </div>

                            <div className="space-y-2">
                              <label className="text-sm font-semibold text-slate-700 ml-1">
                                Nomor WhatsApp
                              </label>
                              <input 
                                type="tel"
                                className="w-full bg-background border-2 border-border rounded-2xl py-4 px-5 text-foreground focus:outline-none focus:border-primary focus:bg-background transition-all font-medium placeholder:text-slate-400 text-base"
                                placeholder="0812..."
                                value={formData.whatsapp}
                                onChange={e => setFormData({...formData, whatsapp: e.target.value.replace(/[^0-9]/g, '')})}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="p-4 bg-primary/10/50 rounded-2xl border border-primary/20/50 flex items-center gap-3">
                          <div className="bg-primary p-1.5 rounded-full shrink-0">
                            <AlertCircle className="size-3.5 text-primary-foreground" />
                          </div>
                          <p className="text-xs text-primary font-medium leading-relaxed">
                            Metode pembayaran QRIS (Dukungan Semua Bank & E-Wallet) tersedia.
                          </p>
                        </div>
                      </motion.div>

                      <div className="lg:col-span-2">
                        <div className="bg-muted/50/50 rounded-2xl p-6 border border-border h-full flex flex-col">
                          <h4 className="text-lg font-semibold text-foreground mb-6">Ringkasan</h4>
                          
                          <div className="bg-background rounded-xl p-4 border border-border shadow-sm mb-6">
                            <div className="flex items-center gap-5">
                              <div className="bg-primary/10 p-3 rounded-2xl">
                                <ShieldCheck className="size-6 text-primary" />
                              </div>
                              <div>
                                <p className="text-xl font-black text-foreground leading-tight">{product?.name}</p>
                                <p className="text-xs font-black text-primary uppercase tracking-[0.2em] mt-1">{variant?.name}</p>
                              </div>
                            </div>
                          </div>

                          {isDailyVariant && (
                            <div className="bg-background rounded-xl p-4 border border-border shadow-sm mb-4 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Durasi Sewa</span>
                                <span className="text-xs font-black text-primary px-2.5 py-0.5 rounded-full bg-primary/10 border border-primary/20">
                                  {durationMultiplier} Hari
                                </span>
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                {[1, 2, 3].map((days) => (
                                  <button
                                    key={days}
                                    type="button"
                                    onClick={() => {
                                      setDurationMultiplier(days);
                                      if (promoData) setPromoData(null);
                                    }}
                                    className={cn(
                                      "py-2.5 rounded-xl font-black text-xs transition-all border",
                                      durationMultiplier === days
                                        ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20 scale-[1.02]"
                                        : "bg-muted/40 text-foreground border-border hover:border-primary/40"
                                    )}
                                  >
                                    {days} Hari
                                  </button>
                                ))}
                              </div>
                              {durationMultiplier > 1 && (
                                <p className="text-[11px] text-muted-foreground leading-relaxed pt-2 border-t border-border/50">
                                  Password akun di-reset per 24 jam. Jika ter-logout di Netflix, buka link voucher Anda untuk menyalin password terbaru.
                                </p>
                              )}
                            </div>
                          )}

                          {/* JUMLAH AKUN (QUANTITY) */}
                          <div className="bg-background rounded-xl p-4 border border-border shadow-sm mb-6 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Jumlah Akun</span>
                              <span className="text-xs font-black text-primary px-2.5 py-0.5 rounded-full bg-primary/10 border border-primary/20">
                                {quantity} Akun
                              </span>
                            </div>
                            <div className="grid grid-cols-5 gap-1.5">
                              {[1, 2, 3, 4, 5].map((qty) => (
                                <button
                                  key={qty}
                                  type="button"
                                  onClick={() => {
                                    setQuantity(qty);
                                    if (promoData) setPromoData(null);
                                  }}
                                  className={cn(
                                    "py-2 rounded-xl font-black text-xs transition-all border",
                                    quantity === qty
                                      ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20 scale-[1.02]"
                                      : "bg-muted/40 text-foreground border-border hover:border-primary/40"
                                  )}
                                >
                                  {qty}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-4 flex-grow">
                            <div className="flex justify-between text-base font-medium text-muted-foreground">
                              <span>
                                Harga Paket
                                {isDailyVariant && durationMultiplier > 1 ? ` (${durationMultiplier} Hari)` : ''}
                                {quantity > 1 ? ` x${quantity}` : ''}
                              </span>
                              <span className="text-foreground">{formatCurrency(rawSubtotal)}</span>
                            </div>
                            <div className="flex justify-between text-base font-medium text-muted-foreground">
                              <span>Biaya Admin</span>
                              <span className="text-accent-foreground font-medium">GRATIS</span>
                            </div>

                            <div className="pt-6 border-t border-border">
                              <p className="text-xs font-medium text-slate-400 uppercase tracking-widest mb-3">Punya Kode Promo?</p>
                              <div className="flex items-stretch border-2 border-border rounded-2xl overflow-hidden focus-within:border-primary transition-all bg-background">
                                <input 
                                  type="text" 
                                  placeholder="Masukkan kode..."
                                  className="flex-1 min-w-0 px-5 py-4 text-sm font-medium focus:outline-none uppercase placeholder:text-slate-300"
                                  value={promoCode}
                                  onChange={(e) => {
                                    setPromoCode(e.target.value)
                                    if (promoError) setPromoError('')
                                    if (promoData) setPromoData(null)
                                  }}
                                />
                                <button 
                                  onClick={handleValidatePromo}
                                  disabled={isPromoLoading || !promoCode || !!promoData}
                                  className="bg-primary text-primary-foreground px-8 font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0 flex items-center justify-center border-l-2 border-border text-xs"
                                >
                                  {isPromoLoading ? <Loader2 className="size-4 animate-spin" /> : (promoData ? 'OK' : 'Gunakan')}
                                </button>
                              </div>
                              {promoError && (
                                <p className="text-[10px] text-red-500 font-bold mt-2 ml-1 uppercase tracking-wider">{promoError}</p>
                              )}
                            </div>

                            <div className="pt-6 border-t-2 border-border border-dashed space-y-4">
                              {promoData && (
                                <div className="flex justify-between text-sm font-medium text-muted-foreground">
                                  <span>Potongan Promo</span>
                                  <span className="text-red-500">-{formatCurrency(promoData.discount_amount)}</span>
                                </div>
                              )}
                              <div className="flex justify-between items-center py-2">
                                <span className="text-lg font-medium text-slate-400">Total Bayar</span>
                                <span className="text-3xl font-bold text-primary tracking-tight">
                                  {formatCurrency(finalAmount)}
                                </span>
                              </div>
                            </div>
                          </div>

                          <button 
                            onClick={handleStep1Submit}
                            className="w-full mt-6 py-5 bg-gradient-to-r from-primary to-primary/80 text-primary-foreground font-black rounded-2xl transition-all flex items-center justify-center gap-3 text-base shadow-xl shadow-primary/20 active:scale-95"
                          >
                            <ShieldCheck className="size-5" />
                            Bayar Sekarang
                          </button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    key="step2"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="p-8 md:p-10 flex flex-col items-center text-center space-y-8"
                  >
                    <div className="relative">
                      <div className="absolute inset-0 bg-primary/100/20 blur-[40px] rounded-full animate-pulse" />
                      <div className="relative bg-background border border-border p-8 rounded-full shadow-xl">
                        <Shield className="size-16 text-primary" />
                      </div>
                    </div>

                    <div className="max-w-md space-y-4">
                      <h3 className="text-2xl font-black text-foreground tracking-tight">Pembayaran Aman</h3>
                      <p className="text-muted-foreground text-sm font-medium leading-relaxed">
                        Anda akan dialihkan ke DOKU Gateway untuk menyelesaikan pembayaran secara aman.
                      </p>
                    </div>

                    <div className="w-full max-w-sm bg-muted/30 border border-border rounded-2xl p-6 space-y-2">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Tagihan</p>
                      <p className="text-3xl font-black text-foreground tracking-tighter">
                        {formatCurrency(finalAmount)}
                      </p>
                    </div>

                    <div className="w-full max-w-sm space-y-4">
                      <button 
                        onClick={handleFinalCheckout}
                        disabled={isLoading}
                        className="w-full py-4 bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-sm rounded-xl flex items-center justify-center gap-2 shadow-lg transition-all active:scale-95 disabled:opacity-50"
                      >
                        {isLoading ? <Loader2 className="size-5 animate-spin" /> : 'Lanjutkan'}
                      </button>
                      <button 
                        onClick={() => setStep(1)}
                        className="w-full py-4 text-slate-400 hover:text-muted-foreground font-bold text-sm transition-colors"
                      >
                        Batalkan
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      )}

      <AnimatePresence>
        {showCloseConfirm && (
          <div key="confirm-portal" className="fixed inset-0 z-[300] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-primary/60 backdrop-blur-sm"
              onClick={() => setShowCloseConfirm(false)}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-background p-8 rounded-[2.5rem] shadow-2xl max-w-sm w-full text-center space-y-6 overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/100/5 blur-3xl -mr-16 -mt-16" />
              
              <div className="bg-primary/10 w-20 h-20 rounded-full flex items-center justify-center mx-auto relative">
                <div className="absolute inset-0 bg-primary/20 animate-ping rounded-full" />
                <AlertCircle className="size-10 text-primary relative" />
              </div>

              <div className="space-y-2">
                <h3 className="text-2xl font-black text-foreground">Batalkan Pesanan?</h3>
                <p className="text-muted-foreground font-medium leading-relaxed">
                  Proses pembayaran Anda sedang berlangsung. Apakah Anda yakin ingin membatalkan?
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 pt-2">
                <button 
                  onClick={() => window.location.reload()}
                  className="w-full py-4 bg-destructive hover:bg-destructive/90 text-destructive-foreground font-black rounded-2xl transition-all shadow-lg active:scale-95"
                >
                  Ya, Batalkan Sekarang
                </button>
                <button 
                  onClick={() => setShowCloseConfirm(false)}
                  className="w-full py-4 bg-muted/50 hover:bg-muted text-muted-foreground font-bold rounded-2xl transition-colors"
                >
                  Lanjutkan Pembayaran
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </AnimatePresence>
    {qrisData && (
      <QrisModal
        isOpen={qrisData.isOpen}
        onClose={() => setQrisData({ ...qrisData, isOpen: false })}
        qrString={qrisData.qrString}
        orderId={qrisData.orderId}
        amount={qrisData.amount}
        productName={qrisData.productName}
      />
    )}
    </>
  )
}
