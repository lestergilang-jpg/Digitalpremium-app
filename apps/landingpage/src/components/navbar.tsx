'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X, ShoppingBag, Home, Package, Key, Crown, BookOpen, FileText, Bell, Clock } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTenant } from '@/hooks/use-tenant'
import { useSettings } from '@/hooks/use-settings'
import { api } from '@/lib/api'
import type { LandingNavbarConfig } from '@volvecapital/shared/types'
import { useNotification } from '@/hooks/use-notification'
import { NotificationPopover } from './notification-popover'
import { ThemeToggle } from './theme-toggle'
import dynamic from 'next/dynamic'
import { Product, ProductVariant } from '@/hooks/use-products'

const CheckoutModal = dynamic(() => import('@/components/checkout-modal').then(mod => mod.CheckoutModal), { ssr: false })

interface NavbarProps {
  config?: LandingNavbarConfig | null
  onReopenCheckout?: (data: any) => void
}

export function Navbar({ config: initialConfig }: NavbarProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [config, setConfig] = useState<LandingNavbarConfig | null>(initialConfig || null)
  const [heroBg, setHeroBg] = useState<string | null>(null)
  const pathname = usePathname()
  const { tenantId } = useTenant()
  const [isNotifOpen, setIsNotifOpen] = useState(false)
  const { unreadCount } = useNotification()

  // Modal State inside Navbar for Notifications
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null)
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false)
  const [checkoutData, setCheckoutData] = useState<any>(null)

  const handleReopenFromNotif = (data: any) => {
    // We need to construct a minimal product/variant object if they are missing
    const mockProduct = { 
      id: data.productId || 'unknown', 
      name: data.productName || 'Product' 
    } as Product;
    
    const mockVariant = { 
      id: data.variantId || 'unknown', 
      name: data.variantName || 'Variant',
      price: data.price || 0
    } as ProductVariant;

    setSelectedProduct(mockProduct);
    setSelectedVariant(mockVariant);
    setCheckoutData(data);
    setIsCheckoutOpen(true);
  }

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const { data: settings } = useSettings(tenantId)

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig)
    } else if (settings && settings.LANDING_NAVBAR) {
      try {
        setConfig(JSON.parse(settings.LANDING_NAVBAR))
      } catch (e) {
        console.error(e)
      }
    }

    if (settings && settings.LANDING_HERO) {
      try {
        const heroConfig = JSON.parse(settings.LANDING_HERO)
        setHeroBg(heroConfig.backgroundImageUrl || null)
      } catch (e) {
        console.error(e)
      }
    }
  }, [initialConfig, settings])

  const navLinks = [
    { name: 'HOME', href: '/', icon: Home },
    { name: 'PRODUK', href: '/product', icon: Package },
    { name: 'TUTORIAL', href: '/tutorial', icon: BookOpen },
    { name: 'BLOG', href: '/blog', icon: FileText },
    { name: 'REDEEM', href: '/redeem', icon: Key },
    { name: 'RIWAYAT', href: '/history', icon: Clock },
  ]

  const brandName = config?.logoText || (tenantId ? tenantId.toUpperCase() : '')
  const logoIcon = config?.logoIconEmbed



  const renderLogoIcon = () => {
    if (!logoIcon) {
      return (
        <div className="h-10 w-10 bg-gradient-to-br from-primary to-primary/80 rounded-xl flex items-center justify-center shadow-lg shadow-primary/20 transition-transform">
          <Crown className="size-6 text-white" />
        </div>
      )
    }

    if (logoIcon.startsWith('<svg')) {
      const encodedSvg = `data:image/svg+xml;utf8,${encodeURIComponent(logoIcon)}`;
      return (
        <div className={`relative h-11 w-auto flex items-center transition-all duration-500 ${!isTransparent ? 'text-primary' : 'text-white'}`}>
          {/* Mask overlay that takes the exact color of text-primary or text-white */}
          <div 
            className="absolute inset-0 bg-current transition-colors duration-500"
            style={{
              maskImage: `url('${encodedSvg}')`,
              WebkitMaskImage: `url('${encodedSvg}')`,
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
              maskPosition: 'left center',
              WebkitMaskSize: 'contain',
              WebkitMaskRepeat: 'no-repeat',
              WebkitMaskPosition: 'left center',
            }}
          />
          {/* Invisible original SVG just to stretch the container to the perfect intrinsic width */}
          <div 
            className="h-full w-auto opacity-0 [&>svg]:h-full [&>svg]:w-auto pointer-events-none"
            dangerouslySetInnerHTML={{ __html: logoIcon }}
          />
        </div>
      )
    }

    return (
      <div className={`h-11 w-auto flex items-center justify-center transition-colors duration-500 overflow-hidden ${!isTransparent ? 'text-primary' : 'text-white'}`}>
        <img 
          src={logoIcon} 
          alt={brandName} 
          className="h-full w-auto object-contain transition-all duration-500"
          style={{
            transform: 'translateX(-9999px)',
            filter: 'drop-shadow(9999px 0 0 currentColor)'
          }}
        />
      </div>
    )
  }

  // Determine if we should use transparent/white text mode
  // Only use white text at the top if we are on HOME and there is a HERO background
  const isHomePage = pathname === '/'
  const isTransparent = !scrolled && isHomePage && heroBg
  
  const textColorClass = isTransparent ? 'text-white' : 'text-foreground'
  const linkColorClass = isTransparent ? 'text-white hover:text-primary' : 'text-muted-foreground hover:text-primary'
  const activeLinkClass = isTransparent ? 'text-white' : 'text-primary'

  return (
    <>
    <nav 
      className={`fixed top-0 left-0 right-0 z-[100] transition-all duration-500 ${
        scrolled 
        ? 'bg-background border-b border-border shadow-lg py-3' 
        : isTransparent
          ? 'bg-transparent py-6 border-b border-transparent'
          : 'bg-background border-b border-border/50 py-5'
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          {renderLogoIcon()}
          <span className={`text-xl font-black tracking-tighter ${textColorClass} group-hover:text-primary transition-colors uppercase`}>
            {brandName}
          </span>
        </Link>

        {/* Desktop Menu */}
        <div className="hidden lg:flex items-center gap-10">
          <div className="flex items-center gap-8">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className={`text-xs font-black tracking-[0.2em] transition-all ${
                  pathname === link.href ? activeLinkClass : linkColorClass
                }`}
              >
                {link.name}
              </Link>
            ))}
          </div>
          
          <div className="flex items-center gap-4">
            {/* Theme Toggle */}
            <ThemeToggle />

            {/* Notification Bell */}
            <div className="relative">
              <button 
                onClick={() => setIsNotifOpen(!isNotifOpen)}
                className={`size-11 flex items-center justify-center rounded-xl transition-all relative ${
                  isTransparent ? 'text-white bg-background/10 hover:bg-background/20' : 'text-foreground bg-muted/50 hover:bg-muted'
                }`}
              >
                <Bell className="size-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 size-5 bg-primary text-primary-foreground text-[10px] font-black flex items-center justify-center rounded-full border-2 border-background">
                    {unreadCount}
                  </span>
                )}
              </button>
              
              <NotificationPopover 
                isOpen={isNotifOpen} 
                onClose={() => setIsNotifOpen(false)}
                onReopenCheckout={handleReopenFromNotif}
              />
            </div>

            <Link 
              href="/product"
              className="flex items-center gap-2 px-6 py-3 bg-gradient-to-br from-primary to-primary/80 text-primary-foreground rounded-2xl font-black text-xs tracking-widest shadow-xl shadow-primary/20 hover:scale-105 active:scale-95 transition-all"
            >
              <ShoppingBag className="size-4" />
              MULAI BELI
            </Link>
          </div>
        </div>

        {/* Mobile Toggle */}
        <div className="flex items-center gap-3 lg:hidden">
          <ThemeToggle />
          
          <div className="relative">
            <button 
              onClick={() => setIsNotifOpen(!isNotifOpen)}
              className={`size-11 flex items-center justify-center rounded-xl transition-all relative ${
                isTransparent ? 'text-white bg-background/10 hover:bg-background/20' : 'text-foreground bg-muted/50 hover:bg-muted'
              }`}
            >
              <Bell className="size-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 size-5 bg-primary text-primary-foreground text-[10px] font-black flex items-center justify-center rounded-full border-2 border-background">
                  {unreadCount}
                </span>
              )}
            </button>
            <NotificationPopover 
              isOpen={isNotifOpen} 
              onClose={() => setIsNotifOpen(false)}
              onReopenCheckout={handleReopenFromNotif}
            />
          </div>
          <button 
            className={`size-11 flex items-center justify-center rounded-xl transition-colors ${
              isTransparent ? 'text-white bg-background/10 hover:bg-background/20' : 'text-foreground bg-muted/50 hover:bg-muted'
            }`}
            onClick={() => setIsOpen(!isOpen)}
          >
            {isOpen ? <X className="size-6" /> : <Menu className="size-6" />}
          </button>
        </div>
      </div>

      {/* Mobile/Tablet Menu */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="lg:hidden bg-background border-t border-border/50 overflow-hidden shadow-2xl"
          >
            <div className="p-8 space-y-5">
              {navLinks.map((link) => (
                <Link
                  key={link.name}
                  href={link.href}
                  onClick={() => setIsOpen(false)}
                  className="flex items-center gap-4 p-5 rounded-3xl bg-muted/50 text-foreground font-black text-sm hover:bg-primary/10 hover:text-primary transition-all"
                >
                  <div className="size-10 bg-background rounded-2xl flex items-center justify-center shadow-sm">
                    <link.icon className="size-5 text-primary" />
                  </div>
                  {link.name}
                </Link>
              ))}
              <Link 
                href="/product"
                onClick={() => setIsOpen(false)}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-primary text-primary-foreground rounded-2xl font-black text-xs tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all"
              >
                <ShoppingBag className="size-5" />
                MULAI BELI
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>

    {isCheckoutOpen && (
      <CheckoutModal 
        isOpen={isCheckoutOpen}
        onClose={() => {
          setIsCheckoutOpen(false)
          setCheckoutData(null)
        }}
        product={selectedProduct}
        variant={selectedVariant}
        initialData={checkoutData}
      />
    )}
    </>
  )
}
