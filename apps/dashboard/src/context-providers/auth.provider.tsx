import type { IAuthContext, ITenant } from './auth-context.type'
import React from 'react'
import { API_URL } from '@/dashboard/constants/api-url.cont'

const AuthContext = React.createContext<IAuthContext | null>(null)

const localStorageKey = 'auth.tenant'

function getStoredTenant() {
  const tenant = localStorage.getItem(localStorageKey)
  if (!tenant)
    return null
  return JSON.parse(tenant)
}

function setStoredTenant(tenant: ITenant | null) {
  if (tenant) {
    localStorage.setItem(localStorageKey, JSON.stringify(tenant))
  }
  else {
    localStorage.removeItem(localStorageKey)
  }
}

// Global interceptor for 401 Unauthorized and 402 Payment Required
const originalFetch = window.fetch
window.fetch = async (...args) => {
  const response = await originalFetch(...args)
  if (response.status === 401) {
    window.dispatchEvent(new Event('vc-unauthorized'))
  }
  else if (response.status === 402) {
    window.dispatchEvent(new Event('vc-payment-required'))
  }
  return response
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [tenant, setTenant] = React.useState<ITenant | null>(getStoredTenant())
  const isAuthenticated = !!tenant

  const logout = React.useCallback(() => {
    setStoredTenant(null)
    setTenant(null)
  }, [])

  const login = React.useCallback(async (email: string, password: string) => {
    const response = await fetch(`${API_URL}/tenant/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    })
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.message || 'Email atau password salah')
    }

    const tenantData = await response.json()
    const tenantStore: ITenant = {
      id: tenantData.id,
      accessToken: tenantData.token,
      role: 'TENANT_OWNER',
      session_id: tenantData.session_id,
      userId: tenantData.id,
    }
    setStoredTenant(tenantStore)
    setTenant(tenantStore)
  }, [])

  const loginAsStaff = React.useCallback(async (email: string, password: string, tenantId: string) => {
    const response = await fetch(`${API_URL}/dashboard-user/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({ email, password }),
    })
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.message || 'Email atau password salah')
    }

    const data = await response.json()
    const tenantStore: ITenant = {
      id: tenantId,
      accessToken: data.token,
      role: 'DASHBOARD_USER',
      permissions: data.permissions ?? [],
      staffName: data.name,
      session_id: data.session_id,
      userId: data.userId,
    }
    setStoredTenant(tenantStore)
    setTenant(tenantStore)
  }, [])

  React.useEffect(() => {
    const stored = getStoredTenant()
    setTenant(stored)

    if (stored && stored.role === 'DASHBOARD_USER') {
      fetch(`${API_URL}/dashboard-user/me`, {
        headers: {
          'Authorization': `VC ${stored.accessToken}`,
          'x-tenant-id': stored.id,
        },
      })
        .then(res => res.ok ? res.json() : Promise.reject('Failed to fetch'))
        .then(data => {
          const updatedTenant: ITenant = {
            ...stored,
            accessToken: data.token ?? stored.accessToken,
            permissions: data.permissions ?? [],
            staffName: data.name,
            session_id: data.session_id ?? stored.session_id,
            userId: data.userId ?? stored.userId,
          }
          setStoredTenant(updatedTenant)
          setTenant(updatedTenant)
        })
        .catch(() => {
          // If the user's session is invalid (e.g. deactivated), log them out
          logout()
        })
    }

    const handleUnauthorized = () => {
      logout()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }

    const handlePaymentRequired = () => {
      if (window.location.pathname !== '/billing') {
        window.location.href = '/billing'
      }
    }
    
    window.addEventListener('vc-unauthorized', handleUnauthorized)
    window.addEventListener('vc-payment-required', handlePaymentRequired)
    return () => {
      window.removeEventListener('vc-unauthorized', handleUnauthorized)
      window.removeEventListener('vc-payment-required', handlePaymentRequired)
    }
  }, [logout])

  return (
    <AuthContext value={{ isAuthenticated, tenant, login, loginAsStaff, logout }}>
      {children}
    </AuthContext>
  )
}

export function useAuth() {
  const context = React.use(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
