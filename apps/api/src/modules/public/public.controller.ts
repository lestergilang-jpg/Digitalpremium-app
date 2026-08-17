import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Ip,
} from '@nestjs/common';
import { TENANT_REPOSITORY } from 'src/constants/database.const';
import { Tenant } from 'src/database/models/tenant.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { PublicRoute } from 'src/guards/public-route.decorator';
import { AccountService } from '../account/account.service';
import { SocketGateway } from '../socket/socket.gateway';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RedeemVoucherDto } from './dto/redeem-voucher.dto';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { PublicService } from './public.service';

@Controller('public')
@PublicRoute()
export class PublicController {
  constructor(
    private readonly publicService: PublicService,
    private readonly socketGateway: SocketGateway,
    private readonly accountService: AccountService,
    private readonly postgresProvider: PostgresProvider,
    @Inject(TENANT_REPOSITORY) private readonly tenantRepository: typeof Tenant,
  ) {}

  private async getTenantId(host: string, xTenantId?: string, xForwardedHost?: string): Promise<string> {
    // 1. Prioritas: header x-tenant-id (dikirim dari dashboard)
    if (xTenantId)
      return xTenantId;

    // x-forwarded-host dikirim dari Next.js server-side fetch untuk custom domain
    // (karena 'host' adalah restricted header di undici/Node.js)
    const effectiveHost = xForwardedHost || host;
    if (!effectiveHost)
      throw new BadRequestException('Missing host or x-tenant-id header');

    // Bersihkan port dari host (e.g. localhost:3000 → localhost)
    const cleanHost = effectiveHost.split(':')[0].toLowerCase();

    // Abaikan resolusi DB saat local development
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1') {
      return 'master';
    }

    // 2. Cek DB: apakah host ini terdaftar sebagai custom domain milik tenant tertentu?
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      const matchedTenant = await this.tenantRepository.findOne({
        where: { custom_domain: cleanHost },
        transaction,
      });
      if (matchedTenant) {
        await transaction.commit();
        return matchedTenant.id;
      }

      // 3. Fallback: gunakan subdomain dari digitalpremium.id (e.g. paytronik.digitalpremium.id)
      const parts = cleanHost.split('.');
      if (parts.length >= 2) {
        const subdomain = parts[0];
        if (subdomain !== 'www') {
          const matchedSubdomain = await this.tenantRepository.findOne({
            where: { id: subdomain },
            transaction,
          });
          if (matchedSubdomain) {
            await transaction.commit();
            return matchedSubdomain.id;
          }
        }
      }
      await transaction.commit();
    }
    catch {
      await transaction.rollback();
    }

    throw new BadRequestException('Tenant ID tidak ditemukan untuk domain/host ini');
  }

  @Get('product')
  async getProducts(@Headers() headers: any) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getProducts(tenantId);
  }

  @Get('settings')
  async getSettings(@Headers() headers: any) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getSettings(tenantId);
  }

  @Post('payment/create')
  async createPayment(
    @Headers() headers: any,
    @Body() dto: CreatePaymentDto,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.createPayment(tenantId, dto);
  }

  @Post('payment/notify')
  handleNotify(
    @Body() body: any,
  ) {
    // For DOKU notifications, extract tenantId from order.invoice_number
    // Format: VC-TENANTID-TIMESTAMP or SUB-TENANTID-TIMESTAMP
    const orderId = body.order?.invoice_number || body.order_id || '';
    const parts = orderId.split('-');

    console.log(`[PaymentNotify] Incoming: ${orderId}, Body: ${JSON.stringify(body)}`);

    if (parts.length < 2) {
      console.error(`[PaymentNotify] Invalid order_id format: ${orderId}`);
      throw new BadRequestException('Invalid order_id format');
    }

    const tenantId = parts[1].toLowerCase();
    console.log(`[PaymentNotify] Extracted Tenant: ${tenantId}`);

    if (parts[0] === 'SUB') {
      return this.publicService.handleSubscriptionPaymentNotify(tenantId, body);
    }

    return this.publicService.handlePaymentNotify(tenantId, body);
  }

  @Post('webhook/doku/payout')
  handlePayoutNotify(
    @Body() body: any,
    @Headers('signature') signature: string,
    @Headers('request-id') requestId: string,
    @Headers('request-timestamp') timestamp: string,
  ) {
    console.log(`[PayoutNotify] Incoming Body: ${JSON.stringify(body)}`);
    // Assuming external_id format: WD-TENANTID-REQUESTID
    // DOKU payload for payout notification structure usually has external_id in the root or transaction
    const externalId = body.transaction?.external_id || body.payouts?.[0]?.external_id || body.external_id || '';
    const parts = externalId.split('-');

    if (parts.length < 3 || parts[0] !== 'WD') {
      console.error(`[PayoutNotify] Invalid external_id format: ${externalId}`);
      throw new BadRequestException('Invalid external_id format');
    }

    const tenantId = parts[1].toLowerCase();
    const withdrawalRequestId = parts.slice(2).join('-');
    console.log(`[PayoutNotify] Extracted Tenant: ${tenantId}, Request: ${withdrawalRequestId}`);

    // Delegate to publicService to handle signature and logic
    return this.publicService.handlePayoutNotify(tenantId, withdrawalRequestId, body, { signature, requestId, timestamp });
  }

  @Get('payment/status/:order_id')
  async checkPaymentStatus(
    @Headers() headers: any,
    @Param('order_id') orderId: string,
  ) {
    let tenantId = '';

    // 1. Try to extract from orderId (VC-TENANT-TIMESTAMP)
    const parts = orderId.split('-');
    if (parts.length >= 2) {
      tenantId = parts[1].toLowerCase();
    }
    else {
      // 2. Fallback to headers
      const host = headers.host || '';
      const xTenantId = headers['x-tenant-id'];
      tenantId = await this.getTenantId(host, xTenantId);
    }

    return this.publicService.checkPaymentStatus(tenantId, orderId);
  }

  @Get('voucher/stock')
  async getStockStatus(@Headers() headers: any) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getStockStatus(tenantId);
  }

  @Get('voucher/:code')
  async getVoucher(
    @Headers() headers: any,
    @Param('code') code: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getVoucher(tenantId, code);
  }

  @Post('voucher/redeem')
  async redeemVoucher(
    @Headers() headers: any,
    @Body() dto: RedeemVoucherDto,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.redeemVoucher(tenantId, dto);
  }

  @Get('email-access/:token')
  async getEmailAccess(
    @Headers() headers: any,
    @Param('token') token: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getEmailAccess(tenantId, token);
  }

  @Get('email-access/:token/netflix-token')
  async getNetflixTokenForBuyer(
    @Headers() headers: any,
    @Param('token') token: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getNetflixTokenForBuyer(tenantId, token);
  }

  @Post('convert-netflix-cookies')
  async convertNetflixCookies(
    @Body('cookies') cookies: any,
    @Headers('x-forwarded-for') xForwardedFor: string,
    @Headers('x-real-ip') xRealIp: string,
    @Ip() ip: string,
  ) {
    const clientIp = xForwardedFor?.split(',')[0].trim() || xRealIp || ip || 'unknown';
    return this.publicService.convertNetflixCookies(cookies, clientIp);
  }


  @Get('tutorial')
  async getTutorials(@Headers() headers: any) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getTutorials(tenantId);
  }

  @Get('tutorial/:slug')
  async getTutorialBySlug(
    @Headers() headers: any,
    @Param('slug') slug: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getTutorialBySlug(tenantId, slug);
  }

  @Get('article')
  async getArticles(@Headers() headers: any) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getArticles(tenantId);
  }

  @Get('article/:slug')
  async getArticleBySlug(
    @Headers() headers: any,
    @Param('slug') slug: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    return this.publicService.getArticleBySlug(tenantId, slug);
  }

  @Get('purchases')
  async getPurchases(
    @Headers() headers: any,
    @Query('identifier') identifier: string,
  ) {
    if (!identifier) {
      throw new BadRequestException('Email atau nomor WhatsApp wajib diisi');
    }
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    
    return this.publicService.getPurchasesByIdentifier(tenantId, identifier);
  }

  @Post('tenant/register')
  async registerTenant(@Body() data: RegisterTenantDto) {
    return await this.publicService.registerTenant(data);
  }

  @Post('auth/forgot-password')
  async forgotPassword(@Body('email') email: string) {
    return await this.publicService.forgotPassword(email);
  }

  @Post('auth/reset-password')
  async resetPassword(@Body() data: any) {
    return await this.publicService.resetPassword(data.token, data.password);
  }

  @Post('reload/confirm-topup')
  async confirmTopup(
    @Headers() headers: any,
    @Body('account_id') accountId: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    if (!accountId)
      throw new BadRequestException('account_id is required');

    // Emit event ke bot yang sedang menunggu konfirmasi top-up
    const eventName = `${accountId}:NETFLIX_TOPUP_CONFIRM`;
    this.socketGateway.sendEvent(eventName, { accountId, tenantId });

    // Bersihkan dari in-memory store
    this.accountService.clearPendingTopup(tenantId, accountId);

    return { message: 'Top-up confirmed, bot will proceed.' };
  }

  @Post('reload/cancel-topup')
  async cancelTopup(
    @Headers() headers: any,
    @Body('account_id') accountId: string,
  ) {
    const host = headers.host || '';
    const xTenantId = headers['x-tenant-id'];
    const xForwardedHost = headers['x-forwarded-host'];
    const tenantId = await this.getTenantId(host, xTenantId, xForwardedHost);
    if (!accountId)
      throw new BadRequestException('account_id is required');

    // Emit event pembatalan ke bot
    const eventName = `${accountId}:NETFLIX_TOPUP_CANCEL`;
    this.socketGateway.sendEvent(eventName, { accountId, tenantId });

    // Bersihkan dari in-memory store
    this.accountService.clearPendingTopup(tenantId, accountId);

    return { message: 'Reload cancelled, bot will stop.' };
  }

  @Post('short-url')
  async createShortUrl(
    @Body('target_url') targetUrl: string,
  ) {
    if (!targetUrl) throw new BadRequestException('target_url is required');
    return this.publicService.createShortUrl(targetUrl);
  }

  @Get('short-url/:code')
  async getShortUrl(
    @Param('code') code: string,
  ) {
    return this.publicService.getShortUrl(code);
  }

  @Get('task-status/:taskId')
  async checkTaskStatus(
    @Param('taskId') taskId: string,
  ) {
    return this.publicService.checkTaskStatus(taskId);
  }
}
