import type { QueryClient } from '@tanstack/react-query'

import type { IAuthContext } from '@/dashboard/context-providers/auth-context.type'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Toaster } from '@/dashboard/components/ui/sonner'
import { GlobalAlertDialogProvider } from '@/dashboard/context-providers/alert-dialog.provider'

interface MyRouterContext {
  queryClient: QueryClient
  auth?: IAuthContext
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  component: () => (
    <>
      <GlobalAlertDialogProvider>
        <Outlet />
      </GlobalAlertDialogProvider>
      <Toaster richColors position="top-center" expand={true} />
    </>
  ),
  errorComponent: ({ error }: any) => (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-4 text-center">
      <AlertCircle className="size-10 text-destructive" />
      <h2 className="text-xl font-bold">Terjadi Kesalahan</h2>
      <p className="text-muted-foreground">{error.message}</p>
    </div>
  ),
  pendingComponent: () => (
    <div className="flex h-screen w-full items-center justify-center">
      <Loader2 className="size-10 animate-spin text-primary" />
    </div>
  ),
})
