import type { Email } from './email.service'
import type { ProductVariant } from './product.service'
import type { MetadataObject } from '@/dashboard/lib/metadata-converter'
import type { GetAllServiceFn } from '@/dashboard/types/get-all-service.type'
import type { Label } from './label.service'
import { z } from 'zod'
import { generateApiFetch, parseApiResponse } from '@/dashboard/lib/api-fetch.util'
import { convertStringToMetadataObject } from '@/dashboard/lib/metadata-converter'
import { BaseQueryParamsSchema } from '@/dashboard/types/get-all-service.type'

export const AccountFilterSchema = z.object({
  email_id: z.string().optional(),
  product_variant_id: z.string().optional(),
  product_id: z.string().optional(),
  product_slug: z.string().optional(),
  status: z.string().optional(),
  email: z.string().optional(),
  user: z.string().optional(),
  billing: z.string().optional(),
  label_ids: z.string().optional(),
})

export type AccountFilter = z.infer<typeof AccountFilterSchema>

export const GetAccountsParamsSchema
  = BaseQueryParamsSchema.merge(AccountFilterSchema)

export interface AccountProfileUser {
  id: string
  name: string
  status?: string
  created_at: Date
  updated_at: Date
  expired_at?: Date
}

export interface AccountProfile {
  id: string
  name: string
  max_user: number
  allow_generate: boolean
  metadata?: Array<MetadataObject>
  user?: Array<AccountProfileUser>
}

export interface Account {
  id: string
  account_password: string
  subscription_expiry: Date
  status?: string
  billing?: string
  label?: string
  batch_start_date?: Date
  batch_end_date?: Date
  freeze_until?: Date
  email_id: string
  product_variant_id: string
  email: Email
  product_variant: ProductVariant
  profile: Array<AccountProfile>
  pinned?: boolean
  capital_price: number
  total_capital?: number
  total_revenue?: number
  profit?: number
  roi?: number
  labels?: Array<Label>
}

export interface AccountCapital {
  id: string
  amount: number
  note?: string
  created_at: Date
}

export interface AccountRevenueDetail {
  transaction_id: string
  amount: number
  date: Date
  user_name: string
}

export interface AccountFinancialDetails {
  capitals: Array<AccountCapital>
  revenues: Array<AccountRevenueDetail>
}

export interface AccountMoveHistory {
  id: string
  account_user_id: string
  from_account_id: string
  from_profile_id: string
  to_account_id: string
  to_profile_id: string
  reason: string
  created_at: Date
  account_user?: AccountProfileUser
  from_account?: Account
  from_profile?: AccountProfile
  to_account?: Account
  to_profile?: AccountProfile
}

export interface AddAccountCapitalPayload {
  amount: number
  note?: string
  date?: string
  payment_coa_id?: string
  expense_coa_id?: string
}

export interface EditAccountCapitalPayload {
  amount?: number
  note?: string
  date?: string
  payment_coa_id?: string
  expense_coa_id?: string
}

export interface CreateAccountProfilePayload {
  account_id?: string
  name: string
  max_user: number
  allow_generate: boolean
  metadata?: string
}

export interface CreateAccountPayload {
  account_password: string
  subscription_expiry: Date
  status?: string
  billing?: string
  label?: string
  email_id: string
  product_variant_id: string
  profile?: Array<CreateAccountProfilePayload>
  capital_price?: number
  payment_coa_id?: string
  expense_coa_id?: string
}

export interface BulkAccountItemPayload {
  email: string
  account_password: string
  subscription_expiry: Date
  status?: string
  billing?: string
  label?: string
  product_variant_id: string
  profile?: Array<CreateAccountProfilePayload>
  payment_coa_id?: string
  expense_coa_id?: string
}

export interface BulkCreateAccountPayload {
  accounts: Array<BulkAccountItemPayload>
}

export interface CreateAccountUserTransaction {
  platform: string
  total_price: number
}

export interface CreateAccountUserPayload {
  name: string
  product_variant_id: string
  status?: string
  account_profile_id?: string
  transaction?: CreateAccountUserTransaction
  expired_at?: Date
}

export interface UpdateAccountUserPayload {
  name?: string
  expired_at?: Date
  status?: string
}

export interface UpdateAccountProfilePayload {
  name?: string
  max_user?: number
  allow_generate?: boolean
  metadata?: string
}

export interface UpdateAccountPayload {
  account_password?: string
  subscription_expiry?: Date
  status?: string
  billing?: string
  label?: string
  email_id?: string
  product_variant_id?: string
  capital_price?: number
}

export interface FreezeAccountPayload {
  duration: number
}

export interface CountStatusAccount {
  accounts_with_slots: number
  accounts_full: number
  profiles_available: number
  accounts_disabled_or_frozen: number
  profiles_locked_but_has_slot: number
  accounts_expiring_today: number
  accounts_reset_today: number
}

export function AccountServiceGenerator(apiUrl: string, accessToken: string, tenantId: string) {
  const getAllAccount: GetAllServiceFn<Account, AccountFilter> = async (
    params,
  ) => {
    const { filter, ...rest } = params
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      '/account',
      { ...rest, ...filter },
    )
    if (!response.ok) {
      const errorData = await parseApiResponse(response)
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to fetch account')
    }

    const data = await response.json()

    const accounts = data.items?.length
      ? (data.items as Array<Account>).map(account => ({
          ...account,
          subscription_expiry: new Date(account.subscription_expiry),
          batch_start_date: account.batch_start_date
            ? new Date(account.batch_start_date)
            : undefined,
          batch_end_date: account.batch_end_date
            ? new Date(account.batch_end_date)
            : undefined,
          freeze_until: account.freeze_until
            ? new Date(account.freeze_until)
            : undefined,
          profile: account.profile.map(profile => ({
            ...profile,
            metadata: convertStringToMetadataObject(profile.metadata as any),
            user: profile.user
              ? profile.user.map(user => ({
                  ...user,
                  created_at: new Date(user.created_at),
                  updated_at: new Date(user.updated_at),
                  expired_at: user.expired_at ? new Date(user.expired_at) : undefined,
                }))
              : undefined,
          })),
        }))
      : []
    return {
      ...data,
      items: accounts,
    }
  }

  const getAccountById = async (accountId: string, signal?: AbortSignal): Promise<Account> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account/${accountId}`,
      { signal },
    )
    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to fetch account')
    }

    const account = await response.json()
    return {
      ...account,
      subscription_expiry: new Date(account.subscription_expiry),
      batch_start_date: account.batch_start_date
        ? new Date(account.batch_start_date)
        : undefined,
      batch_end_date: account.batch_end_date
        ? new Date(account.batch_end_date)
        : undefined,
      freeze_until: account.freeze_until
        ? new Date(account.freeze_until)
        : undefined,
      profile: account.profile.map((profile: AccountProfile) => ({
        ...profile,
        metadata: convertStringToMetadataObject(profile.metadata as any),
      })),
    }
  }

  const createNewAccount = async (
    payload: CreateAccountPayload,
  ): Promise<Account> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      '/account',
      undefined,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to create account')
    }

    return response.json()
  }

  const bulkCreateAccount = async (
    payload: BulkCreateAccountPayload,
  ): Promise<{ success: boolean, message: string, created_accounts: number, created_profiles: number }> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      '/account/bulk',
      undefined,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to bulk create accounts')
    }

    return response.json()
  }

  const createNewAccountProfile = async (
    payload: CreateAccountProfilePayload,
  ): Promise<Account> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      '/account-profile',
      undefined,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to create account')
    }

    return response.json()
  }

  const createNewAccountUser = async (
    payload: CreateAccountUserPayload,
  ): Promise<{ account: Account, profile: AccountProfile }> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      '/account-user',
      undefined,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to create account user')
    }

    const data = await response.json()
    const profile = {
      ...data.profile,
      metadata: data.profile.metadata
        ? convertStringToMetadataObject(data.profile.metadata)
        : undefined,
    }
    return { ...data, profile }
  }

  const updateAccountUser = async (userId: string, payload: UpdateAccountUserPayload): Promise<void> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account-user/${userId}`,
      undefined,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to update account user')
    }
  }

  const updateAccount = async (
    accountId: string,
    payload: UpdateAccountPayload,
  ): Promise<Account> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account/${accountId}`,
      undefined,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to update account')
    }

    return response.json()
  }

  const updateAccountProfile = async (
    accountProfileId: string,
    payload: UpdateAccountProfilePayload,
  ): Promise<Account> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account-profile/${accountProfileId}`,
      undefined,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to update account profile')
    }

    return response.json()
  }

  const freezeAccount = async (
    accountId: string,
    payload: FreezeAccountPayload,
  ) => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account/${accountId}/freeze`,
      undefined,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to freeze account')
    }
  }

  const unfreezeAccount = async (accountId: string) => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account/${accountId}/unfreeze`,
      undefined,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to unfreeze account')
    }
  }

  const deleteAccount = async (accountId: string): Promise<void> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account/${accountId}`,
      undefined,
      {
        method: 'DELETE',
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to delete account')
    }
  }

  const deleteAccountProfile = async (
    accountProfileId: string,
  ): Promise<void> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account-profile/${accountProfileId}`,
      undefined,
      {
        method: 'DELETE',
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to delete account profile')
    }
  }

  const countStatusAccount = async (
    filter?: { product_variant_id?: string, product_id?: string, product_slug?: string },
    signal?: AbortSignal,
  ): Promise<CountStatusAccount> => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      '/account/count',
      { ...filter, signal },
    )
    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to fetch count account')
    }

    return await response.json()
  }

  const pinAccount = async (accountId: string, pinned: boolean) => {
    const response = await generateApiFetch(
      apiUrl,
      accessToken,
      tenantId,
      `/account/${accountId}`,
      undefined,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to pin account')
    }
  }

  return {
    getAllAccount,
    getAccountById,
    createNewAccount,
    bulkCreateAccount,
    createNewAccountProfile,
    createNewAccountUser,
    updateAccountUser,
    updateAccount,
    updateAccountProfile,
    freezeAccount,
    unfreezeAccount,
    deleteAccount,
    deleteAccountProfile,
    countStatusAccount,
    pinAccount,
    getFinancialDetails: async (accountId: string): Promise<AccountFinancialDetails> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/financial-details`,
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to fetch financial details')
      }
      const data = await response.json()
      return {
        capitals: data.capitals.map((c: any) => ({ ...c, created_at: new Date(c.created_at) })),
        revenues: data.revenues.map((r: any) => ({ ...r, date: new Date(r.date) })),
      }
    },
    addAccountCapital: async (accountId: string, payload: AddAccountCapitalPayload): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/capital`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to add capital')
      }
    },
    editAccountCapital: async (accountId: string, capitalId: string, payload: EditAccountCapitalPayload): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/capital/${capitalId}`,
        undefined,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to edit capital')
      }
    },
    deleteAccountCapital: async (accountId: string, capitalId: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/capital/${capitalId}`,
        undefined,
        {
          method: 'DELETE',
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to delete capital')
      }
    },
    triggerReset: async (accountId: string, targetBot?: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/reset`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_bot: targetBot }),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to trigger reset')
      }
    },
    triggerReload: async (accountId: string, targetBot?: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/reload`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_bot: targetBot }),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to trigger reload')
      }
    },
    triggerUpgrade: async (accountId: string, targetBot?: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/upgrade`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_bot: targetBot }),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to trigger upgrade')
      }
    },
    triggerLoginTv: async (accountId: string, targetBot?: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/login-tv`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_bot: targetBot }),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to trigger Login TV')
      }
    },
    confirmTopup: async (accountId: string): Promise<void> => {
      const response = await fetch(`${apiUrl}/public/reload/confirm-topup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ account_id: accountId }),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as any
        throw new Error(errorData.message || 'Failed to confirm topup')
      }
    },
    cancelTopup: async (accountId: string): Promise<void> => {
      const response = await fetch(`${apiUrl}/public/reload/cancel-topup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ account_id: accountId }),
      })
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as any
        throw new Error(errorData.message || 'Failed to cancel topup')
      }
    },
    getPendingTopups: async (): Promise<{ accountId: string, email: string, billing: string, taskId: string }[]> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        '/account/pending-topups',
      )
      if (!response.ok) {
        return []
      }
      return await response.json()
    },
    bulkAction: async (ids: string[], action: string, payload?: any): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        '/account/bulk',
        undefined,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, action, payload }),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to perform bulk action')
      }
    },
    assignLabel: async (accountId: string, labelId: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/labels`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label_id: labelId }),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to assign label')
      }
    },
    unassignLabel: async (accountId: string, labelId: string): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/labels/${labelId}`,
        undefined,
        {
          method: 'DELETE',
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Failed to unassign label')
      }
    },
    moveUser: async (userId: string, data: { to_account_id: string; to_profile_id: string; reason: string; allow_old_profile_generate?: boolean }): Promise<void> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/users/${userId}/move`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      )
      if (!response.ok) {
        const errorData = await parseApiResponse(response)
        throw new Error(errorData.message || 'Gagal memindah pengguna')
      }
    },
    getMoveRecommendations: async (userId: string): Promise<Account[]> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/users/${userId}/move-recommendations`,
      )
      const data = await parseApiResponse(response)
      if (!response.ok) throw new Error(data.message || 'Gagal memuat rekomendasi')
      return data
    },
    getAccountMoveHistory: async (accountId: string): Promise<AccountMoveHistory[]> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/move-history`,
      )
      const data = await parseApiResponse(response)
      if (!response.ok) throw new Error(data.message || 'Gagal memuat riwayat')
      return data
    },
    getProductMoveHistory: async (productId: string): Promise<AccountMoveHistory[]> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/product/${productId}/move-history`,
      )
      const data = await parseApiResponse(response)
      if (!response.ok) throw new Error(data.message || 'Gagal memuat riwayat produk')
      return data
    },
    getNetflixToken: async (accountId: string): Promise<{ token?: string, pcLink?: string, mobileLink?: string, tvLink?: string, generalLink?: string, status?: string, taskId?: string }> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/netflix-token`,
      )
      const data = await parseApiResponse(response)
      if (!response.ok) throw new Error(data.message || 'Gagal mengambil token')
      return data
    },
    importNetflixCookies: async (accountId: string, cookies: any): Promise<{ success: boolean; message: string }> => {
      const response = await generateApiFetch(
        apiUrl,
        accessToken,
        tenantId,
        `/account/${accountId}/import-netflix-cookies`,
        undefined,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies }),
        },
      )
      const data = await parseApiResponse(response)
      if (!response.ok) throw new Error(data.message || 'Gagal mengimpor cookie')
      return data
    },
  }
}
