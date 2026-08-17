import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { 
  Cpu, 
  Globe, 
  CreditCard, 
  ArrowRight, 
  Check, 
  ChevronDown,
  Zap,
  Sparkles,
  Loader2,
  Tv,
  Smartphone,
  Laptop,
  Link2,
  Copy,
  AlertTriangle
} from 'lucide-react'
import { useScrollReveal } from '@/dashboard/hooks/use-scroll-reveal'
import { toast } from 'sonner'
import { API_URL } from '../constants/api-url.cont'
import logo from '../logo.svg'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  // Scroll reveal references
  const heroRef = useScrollReveal()
  const featuresRef = useScrollReveal()
  const nftokenRef = useScrollReveal()
  const workflowRef = useScrollReveal()
  const faqRef = useScrollReveal()

  // NFtoken Converter States
  const [cookiesInput, setCookiesInput] = useState('')
  const [isConverting, setIsConverting] = useState(false)
  const [conversionLimitMessage, setConversionLimitMessage] = useState<string | null>(null)
  const [conversionResult, setConversionResult] = useState<{
    pcLink: string;
    mobileLink: string;
    tvLink: string;
    generalLink: string;
  } | null>(null)

  const handleConvertCookies = async () => {
    if (!cookiesInput.trim()) {
      toast.error('Cookies tidak boleh kosong!')
      return
    }

    setIsConverting(true)
    setConversionLimitMessage(null)
    setConversionResult(null)
    try {
      const response = await fetch(`${API_URL}/public/convert-netflix-cookies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cookies: cookiesInput }),
      })

      const data = await response.json()
      if (!response.ok) {
        if (data.message && data.message.includes('Batas konversi harian')) {
          setConversionLimitMessage(data.message)
          return
        }
        throw new Error(data.message || 'Gagal mengonversi cookie')
      }

      setConversionResult(data)
      toast.success('Cookies berhasil dikonversi ke token link!')
    } catch (err: any) {
      toast.error(err.message || 'Gagal mengonversi cookies. Silakan coba lagi.')
    } finally {
      setIsConverting(false)
    }
  }

  // Accordion FAQ State
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index)
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground overflow-x-hidden antialiased">
      
      {/* HEADER / NAVBAR */}
      <header className="sticky top-0 z-50 bg-background/85 backdrop-blur-md border-b border-border transition-colors">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center">
            <img src={logo} alt="Digital Premium Logo" className="h-10 w-auto" />
          </div>

          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
            <a href="#features" className="hover:text-primary transition-colors">Fitur Utama</a>
            <a href="#nftoken-converter" className="hover:text-primary transition-colors">Converter Cookies</a>
            <a href="#workflow" className="hover:text-primary transition-colors">Cara Kerja</a>
            <a href="#faq" className="hover:text-primary transition-colors">FAQ</a>
          </nav>

          <div className="flex items-center gap-3">
            <Link 
              to="/login"
              className="px-4.5 py-2.5 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              Masuk
            </Link>
            <Link 
              to="/register"
              className="px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl shadow-sm hover:scale-105 active:scale-95 transition-all"
            >
              Daftar Sekarang
            </Link>
          </div>
        </div>
      </header>

      {/* HERO SECTION */}
      <section ref={heroRef} className="relative min-h-[calc(100vh-80px)] flex flex-col items-center justify-center max-w-7xl mx-auto px-6 text-center">
        {/* Trial Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-border bg-muted text-muted-foreground mb-8 reveal-hidden">
          <Sparkles className="size-4 text-primary" />
          <span className="text-xs font-black uppercase tracking-wider">
            🎉 GRATIS TRIAL 30 HARI - TANPA KARTU KREDIT
          </span>
        </div>

        {/* Title */}
        <h1 className="text-5xl md:text-7xl font-black tracking-tight max-w-5xl leading-[1.1] mb-8 text-foreground reveal-hidden delay-100">
          Kelola & Jual Akses Akun Premium Dengan{' '}
          <span className="text-primary">
            Otomatisasi 24/7
          </span>
        </h1>

        {/* Subtitle */}
        <p className="text-lg md:text-xl text-muted-foreground max-w-3xl leading-relaxed mb-12 font-medium reveal-hidden delay-200">
          Solusi *Shared Apps Management* terbaik untuk reseller dan bisnis voucher. Kelola ribuan profil Netflix, Spotify, Disney+, dan YouTube secara instan. User redeem, sistem & bot kami langsung mengalokasikan akun.
        </p>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto reveal-hidden delay-300">
          <Link 
            to="/register"
            className="px-8 py-4 bg-primary hover:bg-primary/95 text-primary-foreground font-bold rounded-2xl flex items-center gap-3 w-full sm:w-auto justify-center text-lg shadow-md hover:scale-105 active:scale-95 transition-all"
          >
            Mulai Trial 30 Hari Anda
            <ArrowRight className="size-5" />
          </Link>
          <a
            href="#nftoken-converter"
            className="px-8 py-4 bg-secondary text-secondary-foreground font-bold rounded-2xl hover:bg-secondary/90 hover:scale-105 active:scale-95 transition-all w-full sm:w-auto text-center text-lg shadow-sm border border-border"
          >
            Converter Cookies
          </a>
        </div>
      </section>

      {/* CORE FEATURES */}
      <section ref={featuresRef} id="features" className="py-24 bg-muted/30 border-y border-border">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-20">
            <p className="text-xs font-black tracking-[0.3em] text-primary uppercase mb-4 reveal-hidden">
              Mengapa Memilih Kami
            </p>
            <h2 className="text-3xl md:text-5xl font-black tracking-tight text-foreground reveal-hidden delay-100">
              Fitur Lengkap Untuk Skala Bisnis Anda
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {/* Feature 1 */}
            <div className="group p-8 bg-card rounded-3xl border border-border transition-all duration-300 hover:-translate-y-2 hover:shadow-md reveal-hidden delay-100">
              <div className="size-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <Cpu className="size-6 text-primary" />
              </div>
              <h3 className="text-xl font-bold text-card-foreground mb-3">Alokasi Akun Otomatis</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Pembeli melakukan redeem, sistem kami langsung memilih akun dan profil yang siap pakai, serta mengirimkannya secara real-time.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="group p-8 bg-card rounded-3xl border border-border transition-all duration-300 hover:-translate-y-2 hover:shadow-md reveal-hidden delay-200">
              <div className="size-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <Zap className="size-6 text-primary" />
              </div>
              <h3 className="text-xl font-bold text-card-foreground mb-3">Integrasi Bot Otomatisasi</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Dilengkapi bot cerdas untuk menjaga kestabilan sesi login, verifikasi otomatis, serta mempermudah penggantian cookie jika terjadi reset sandi.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="group p-8 bg-card rounded-3xl border border-border transition-all duration-300 hover:-translate-y-2 hover:shadow-md reveal-hidden delay-300">
              <div className="size-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <Globe className="size-6 text-primary" />
              </div>
              <h3 className="text-xl font-bold text-card-foreground mb-3">Subdomain White-Label</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Setiap tenant mendapatkan portal penjualan eksklusif dengan custom subdomain, pengaturan produk sendiri, serta logo & tema kustom.
              </p>
            </div>

            {/* Feature 4 */}
            <div className="group p-8 bg-card rounded-3xl border border-border transition-all duration-300 hover:-translate-y-2 hover:shadow-md reveal-hidden delay-400">
              <div className="size-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <CreditCard className="size-6 text-primary" />
              </div>
              <h3 className="text-xl font-bold text-card-foreground mb-3">Gateway Doku & Midtrans</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Terintegrasi langsung dengan payment gateway lokal ternama untuk mempermudah penerimaan pembayaran otomatis via QRIS dan E-Wallet.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* NFTOKEN COOKIE CONVERTER SECTION */}
      <section ref={nftokenRef} id="nftoken-converter" className="py-24 max-w-7xl mx-auto px-6">
        <div className="bg-card border border-border rounded-3xl p-8 md:p-16 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-[100px] pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-96 h-96 bg-purple-500/10 rounded-full blur-[100px] pointer-events-none" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start relative z-10">
            <div>
              <p className="text-xs font-black tracking-[0.3em] text-primary uppercase mb-4 reveal-hidden">
                Fitur Unggulan Premium
              </p>
              <h2 className="text-3xl md:text-5xl font-black tracking-tight text-foreground mb-6 reveal-hidden delay-100">
                Netflix Cookie to Token Converter
              </h2>
              <p className="text-muted-foreground mb-8 leading-relaxed reveal-hidden delay-200">
                Fitur canggih yang memungkinkan Anda mengonversi cookies Netflix (format JSON) menjadi tautan login otomatis sekali klik (nftoken). Menghindari proses login manual yang merepotkan dan langsung kompatibel di berbagai perangkat.
              </p>

              {/* Instructions */}
              <div className="space-y-4 reveal-hidden delay-300">
                <h4 className="font-bold text-foreground text-sm uppercase tracking-wider">Cara Penggunaan:</h4>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <span className="flex-shrink-0 size-6 bg-primary/15 text-primary rounded-full flex items-center justify-center text-xs font-bold">1</span>
                    <p className="text-muted-foreground text-sm">Ekspor cookies Netflix dari akun Anda menggunakan ekstensi browser seperti <strong className="text-foreground">EditThisCookie</strong> dalam format JSON.</p>
                  </div>
                  <div className="flex gap-3">
                    <span className="flex-shrink-0 size-6 bg-primary/15 text-primary rounded-full flex items-center justify-center text-xs font-bold">2</span>
                    <p className="text-muted-foreground text-sm">Tempel kode JSON tersebut pada kotak input yang telah disediakan di samping.</p>
                  </div>
                  <div className="flex gap-3">
                    <span className="flex-shrink-0 size-6 bg-primary/15 text-primary rounded-full flex items-center justify-center text-xs font-bold">3</span>
                    <p className="text-muted-foreground text-sm">Klik <strong className="text-foreground">Konversi Cookies</strong>, lalu salin link login otomatis per perangkat sesuai kebutuhan Anda.</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Interactive Panel */}
            <div className="p-8 bg-muted/30 border border-border rounded-2xl space-y-6 reveal-hidden delay-200 backdrop-blur-sm">
              <div className="space-y-2">
                <label className="block text-sm font-bold text-muted-foreground">JSON Cookies Netflix</label>
                <textarea
                  value={cookiesInput}
                  onChange={(e) => setCookiesInput(e.target.value)}
                  placeholder='Paste JSON cookies di sini... Contoh: [{"name": "NetflixId", "value": "..."}]'
                  className="w-full h-36 p-4 rounded-xl border border-border bg-background/50 text-foreground placeholder:text-muted-foreground/60 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all resize-none"
                  disabled={isConverting}
                />
              </div>

              <button
                onClick={handleConvertCookies}
                disabled={isConverting || !cookiesInput.trim()}
                className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed group shadow-lg shadow-primary/20 hover:shadow-primary/30"
              >
                {isConverting ? (
                  <>
                    <Loader2 className="size-5 animate-spin" />
                    Memproses Cookies...
                  </>
                ) : (
                  <>
                    <Sparkles className="size-5 group-hover:scale-110 transition-transform" />
                    Konversi Cookies
                  </>
                )}
              </button>

              {/* Conversion Limit Error Message */}
              {conversionLimitMessage && (
                <div className="pt-6 border-t border-border space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
                  <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-4.5 flex flex-col gap-3">
                    <div className="flex gap-2.5 items-start">
                      <AlertTriangle className="size-5 text-destructive shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <h4 className="font-bold text-sm text-foreground">Batas Konversi Tercapai</h4>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {conversionLimitMessage}
                        </p>
                      </div>
                    </div>
                    <Link
                      to="/register"
                      className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-lg flex items-center justify-center text-xs shadow-sm shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
                    >
                      Daftar Sekarang & Dapatkan Akses Tanpa Batas
                    </Link>
                  </div>
                </div>
              )}

              {/* Conversion Output Results */}
              {conversionResult && (
                <div className="pt-6 border-t border-border space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
                  <h4 className="font-bold text-sm text-foreground flex items-center gap-2">
                    <Check className="size-4 text-emerald-500" /> Tautan Berhasil Dibuat
                  </h4>
                  <div className="space-y-3">
                    {[
                      { 
                        label: 'TV Link', 
                        url: conversionResult.tvLink, 
                        icon: Tv,
                        description: 'Akses tautan ini, lalu masukkan 8-digit kode aktivasi dari layar TV Anda.'
                      },
                      { 
                        label: 'Mobile Link', 
                        url: conversionResult.mobileLink, 
                        icon: Smartphone,
                        description: 'Akses tautan ini di browser HP Anda dan pilih \'Lanjutkan\' untuk dialihkan secara otomatis ke aplikasi Netflix dan langsung masuk.'
                      },
                      { 
                        label: 'PC Link', 
                        url: conversionResult.pcLink, 
                        icon: Laptop,
                        description: 'Akses tautan ini di browser PC/Laptop Anda untuk langsung masuk secara otomatis.'
                      },
                      { 
                        label: 'General Link', 
                        url: conversionResult.generalLink, 
                        icon: Link2,
                        description: 'Akses tautan ini untuk dialihkan langsung ke halaman detail akun Netflix Anda.'
                      },
                    ].map((link, idx) => {
                      const Icon = link.icon;
                      const displayUrl = link.url;
                      return (
                        <div key={idx} className="space-y-1.5 bg-background/30 p-3.5 border border-border/50 rounded-xl">
                          <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                            <Icon className="size-3.5 text-primary" /> {link.label}
                          </span>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              readOnly
                              value={displayUrl}
                              onClick={(e) => (e.target as HTMLInputElement).select()}
                              className="w-full h-10 px-3 rounded-lg border border-border bg-background/80 text-muted-foreground text-xs font-mono focus:outline-none"
                            />
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(displayUrl);
                                toast.success(`${link.label} disalin ke clipboard!`);
                              }}
                              className="px-3 h-10 rounded-lg border border-border bg-card hover:bg-muted text-card-foreground hover:text-foreground transition-all flex items-center justify-center gap-1.5 text-xs font-bold"
                            >
                              <Copy className="size-3.5" /> Copy
                            </button>
                          </div>
                          <p className="text-[10.5px] text-muted-foreground leading-relaxed pl-1 pt-0.5">
                            {link.description}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* WORKFLOW / STEPS */}
      <section ref={workflowRef} id="workflow" className="py-24 bg-muted/20 border-t border-border">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-20">
            <p className="text-xs font-black tracking-[0.3em] text-primary uppercase mb-4 reveal-hidden">
              Cara Kerja
            </p>
            <h2 className="text-3xl md:text-5xl font-black tracking-tight text-foreground reveal-hidden delay-100">
              Tiga Langkah Mudah Memulai Bisnis Anda
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 relative">
            {/* Step 1 */}
            <div className="relative text-center reveal-hidden delay-100">
              <div className="size-16 bg-card border border-border rounded-full flex items-center justify-center mx-auto mb-6 text-xl font-black text-primary relative z-10 shadow-sm">
                1
              </div>
              <h3 className="text-xl font-bold text-foreground mb-3">Buat Akun & Tenant</h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-xs mx-auto">
                Registrasi akun Anda secara instan. Mulai trial 30 hari secara gratis tanpa syarat pembayaran apapun.
              </p>
            </div>

            {/* Step 2 */}
            <div className="relative text-center reveal-hidden delay-200">
              <div className="size-16 bg-card border border-border rounded-full flex items-center justify-center mx-auto mb-6 text-xl font-black text-primary relative z-10 shadow-sm">
                2
              </div>
              <h3 className="text-xl font-bold text-foreground mb-3">Atur Produk & Subdomain</h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-xs mx-auto">
                Tentukan produk streaming yang ingin Anda jual, tentukan harga kustom, dan setup subdomain white-label Anda.
              </p>
            </div>

            {/* Step 3 */}
            <div className="relative text-center reveal-hidden delay-300">
              <div className="size-16 bg-card border border-border rounded-full flex items-center justify-center mx-auto mb-6 text-xl font-black text-primary relative z-10 shadow-sm">
                3
              </div>
              <h3 className="text-xl font-bold text-foreground mb-3">Mulai Berjualan Otomatis</h3>
              <p className="text-muted-foreground text-sm leading-relaxed max-w-xs mx-auto">
                Sistem & payment gateway Anda siap melayani pembeli. Pembagian profile dan pengiriman akun berjalan serba otomatis.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ SECTION */}
      <section ref={faqRef} id="faq" className="py-24 max-w-4xl mx-auto px-6">
        <div className="text-center mb-16">
          <p className="text-xs font-black tracking-[0.3em] text-primary uppercase mb-4 reveal-hidden">
            Pertanyaan Umum
          </p>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight text-foreground reveal-hidden delay-100">
            FAQ Seputar Layanan Kami
          </h2>
        </div>

        <div className="space-y-4">
          {[
            {
              q: "Bagaimana cara kerja trial 30 hari?",
              a: "Saat Anda mendaftar, platform tenant Anda akan langsung aktif dengan fitur penuh selama 30 hari. Anda tidak perlu memasukkan informasi kartu kredit atau melakukan pembayaran apapun untuk masa trial."
            },
            {
              q: "Apakah saya harus menyediakan akun premium sendiri?",
              a: "Ya, Anda mengunggah akun premium (seperti Netflix atau Spotify) milik Anda sendiri ke dalam database admin tenant. Sistem kami akan secara otomatis mengelola, membagi profil, dan mengalokasikannya ke pembeli Anda."
            },
            {
              q: "Bagaimana jika masa trial 30 hari saya berakhir?",
              a: "Setelah 30 hari berakhir, sistem akan mengarahkan Anda secara otomatis ke halaman tagihan (billing). Anda cukup membayar biaya langganan bulanan platform melalui Doku payment gateway (QRIS/E-wallet) untuk melanjutkan layanan."
            },
            {
              q: "Apakah saya bisa menggunakan nama domain saya sendiri?",
              a: "Tentu! Secara default Anda akan mendapatkan subdomain digitalpremium.id (misal: tokoanda.digitalpremium.id). Namun, Anda juga dapat menghubungkannya ke custom domain pribadi Anda."
            }
          ].map((item, idx) => (
            <div 
              key={idx} 
              className="bg-card border border-border rounded-2xl overflow-hidden transition-colors reveal-hidden"
            >
              <button
                onClick={() => toggleFaq(idx)}
                className="w-full p-6 text-left flex justify-between items-center font-bold text-foreground hover:text-primary transition-colors"
              >
                <span>{item.q}</span>
                <ChevronDown className={`size-5 text-muted-foreground transition-transform ${openFaq === idx ? 'rotate-180 text-primary' : ''}`} />
              </button>
              {openFaq === idx && (
                <div className="px-6 pb-6 text-sm text-muted-foreground leading-relaxed border-t border-border pt-4">
                  {item.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-background border-t border-border py-12">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">
              © {new Date().getFullYear()} Digital Premium. All rights reserved.
            </span>
          </div>

          <div className="flex items-center gap-6 text-sm text-muted-foreground font-semibold">
            <Link to="/login" className="hover:text-foreground">Login Tenant</Link>
            <Link to="/register" className="hover:text-foreground">Daftar Tenant</Link>
            <a href="#features" className="hover:text-foreground">Fitur</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
