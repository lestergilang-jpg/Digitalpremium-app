import type { GetAllServiceFn } from '../types/get-all-service.type'
import { z } from 'zod'
import { generateApiFetch, parseApiResponse } from '../lib/api-fetch.util'
import { BaseQueryParamsSchema } from '../types/get-all-service.type'

export const EmailMessageFilterSchema = z.object({
  recipient_email: z.string().optional(),
})

export type EmailMessageFilter = z.infer<typeof EmailMessageFilterSchema>

export const GetEmailMessageParamsSchema = BaseQueryParamsSchema.merge(
  EmailMessageFilterSchema,
)

export type GetEmailMessageParams = z.infer<typeof GetEmailMessageParamsSchema>

export interface EmailMessage {
  id: string
  tenant_id: string
  from_email: string
  recipient_email: string
  subject: string
  email_date: Date
  parsed_context: string
  parsed_data: string
  created_at: Date
  updated_at: Date
}

export function EmailMessageServiceGenerator(apiUrl: string, accessToken: string, tenantId: string) {
  const getEmailMessages: GetAllServiceFn<EmailMessage, EmailMessageFilter> = async (params) => {
    const response = await generateApiFetch(apiUrl, accessToken, tenantId, '/email-message', params)
    if (!response.ok) {
      const errorData = await parseApiResponse(response)
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to fetch email messages')
    }

    const data = await response.json()
    const emailMessages = data.items?.length
      ? (data.items as Array<EmailMessage>).map(emailMessage => ({
          ...emailMessage,
          email_date: new Date(emailMessage.email_date),
          created_at: new Date(emailMessage.created_at),
          updated_at: new Date(emailMessage.updated_at),
        }))
      : []

    return {
      ...data,
      items: emailMessages,
    }
  }

  const cleanupEmailMessages = async () => {
    const response = await fetch(`${apiUrl}/email-message/cleanup`, {
      method: 'DELETE',
      headers: {
        'Authorization': `VC ${accessToken}`,
        'X-Tenant-ID': tenantId,
      },
    })
    
    if (!response.ok) {
      const errorData = await parseApiResponse(response)
      const errorMessage = Array.isArray(errorData.message)
        ? errorData.message[0]
        : errorData.message
      throw new Error(errorMessage || 'Failed to cleanup email messages')
    }
    
    return response.json()
  }

  return {
    getEmailMessages,
    cleanupEmailMessages,
  }
}
