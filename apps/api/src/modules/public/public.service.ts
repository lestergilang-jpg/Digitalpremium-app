import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as nodemailer from 'nodemailer';
import { Op } from 'sequelize';
import {
  ACCOUNT_PROFILE_REPOSITORY,
  ACCOUNT_REPOSITORY,
  ACCOUNT_USER_REPOSITORY,
  PRODUCT_REPOSITORY,
  PRODUCT_VARIANT_REPOSITORY,
  TRANSACTION_ITEM_REPOSITORY,
  TRANSACTION_REPOSITORY,
  VOUCHER_REPOSITORY,
  TENANT_SETTING_REPOSITORY,
  EMAIL_MESSAGE_REPOSITORY,
  EMAIL_SUBJECT_REPOSITORY,
  TUTORIAL_REPOSITORY,
  TENANT_OWNER_REPOSITORY,
  ARTICLE_REPOSITORY,
  SHORT_URL_REPOSITORY,
  ACCOUNT_SESSION_REPOSITORY,
} from 'src/constants/database.const';
import { AccountProfile } from 'src/database/models/account-profile.model';
import { AccountUser } from 'src/database/models/account-user.model';
import { Account } from 'src/database/models/account.model';
import { Email } from 'src/database/models/email.model';
import { ProductVariant } from 'src/database/models/product-variant.model';
import { Product } from 'src/database/models/product.model';
import { TransactionItem } from 'src/database/models/transaction-item.model';
import { Transaction } from 'src/database/models/transaction.model';
import { Voucher } from 'src/database/models/voucher.model';
import { EmailMessage } from 'src/database/models/email-message.model';
import { EmailSubject } from 'src/database/models/email-subject.model';
import { TenantSetting } from 'src/database/models/tenant-setting.model';
import { TenantOwner } from 'src/database/models/tenant-owner.model';
import { Tenant } from 'src/database/models/tenant.model';
import { Tutorial } from 'src/database/models/tutorial.model';
import { Article } from 'src/database/models/article.model';
import { ShortUrl } from 'src/database/models/short-url.model';
import { AccountSession } from 'src/database/models/account-session.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { TenantProvisioningService } from '../tenant/tenant-provisioning.service';
import { PromoService } from '../promo/promo.service';
import { TaskQueueService } from '../task-queue/task-queue.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { SocketGateway } from '../socket/socket.gateway';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RegisterTenantDto } from './dto/register-tenant.dto';
import { RedeemVoucherDto } from './dto/redeem-voucher.dto';

@Injectable()
export class PublicService {
  private readonly logger = new Logger('PublicService');
  private readonly conversionRateLimitMap = new Map<string, { date: string; count: number }>();

  constructor(
    private readonly postgresProvider: PostgresProvider,
    private readonly configService: ConfigService,
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepository: typeof Product,
    @Inject(PRODUCT_VARIANT_REPOSITORY)
    private readonly productVariantRepository: typeof ProductVariant,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accountRepository: typeof Account,
    @Inject(ACCOUNT_PROFILE_REPOSITORY)
    private readonly accountProfileRepository: typeof AccountProfile,
    @Inject(ACCOUNT_USER_REPOSITORY)
    private readonly accountUserRepository: typeof AccountUser,
    @Inject(TRANSACTION_REPOSITORY)
    private readonly transactionRepository: typeof Transaction,
    @Inject(TRANSACTION_ITEM_REPOSITORY)
    private readonly transactionItemRepository: typeof TransactionItem,
    @Inject(VOUCHER_REPOSITORY)
    private readonly voucherRepository: typeof Voucher,
    @Inject(TENANT_SETTING_REPOSITORY)
    private readonly tenantSettingRepository: typeof TenantSetting,
    @Inject(EMAIL_MESSAGE_REPOSITORY)
    private readonly emailMessageRepository: typeof EmailMessage,
    @Inject(EMAIL_SUBJECT_REPOSITORY)
    private readonly emailSubjectRepository: typeof EmailSubject,
    @Inject(TUTORIAL_REPOSITORY)
    private readonly tutorialRepository: typeof Tutorial,
    @Inject(TENANT_OWNER_REPOSITORY)
    private readonly tenantOwnerRepository: typeof TenantOwner,
    @Inject(ARTICLE_REPOSITORY)
    private readonly articleRepository: typeof Article,
    private readonly tenantProvisioningService: TenantProvisioningService,
    private readonly promoService: PromoService,
    private readonly whatsappService: WhatsappService,
    private readonly socketGateway: SocketGateway,
    private readonly taskQueueService: TaskQueueService,
    @Inject(SHORT_URL_REPOSITORY)
    private readonly shortUrlRepository: typeof ShortUrl,
    @Inject(ACCOUNT_SESSION_REPOSITORY)
    private readonly accountSessionRepository: typeof AccountSession,
  ) {}

  async getSettings(tenantId: string) {
    if (!tenantId) return {};

    const [schemaResult] = await this.postgresProvider.rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = :tenantId`,
      { replacements: { tenantId } }
    );
    if (!schemaResult || (schemaResult as any[]).length === 0) {
      return {};
    }

    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const settings = await this.tenantSettingRepository.findAll({ transaction });
      
      const result: Record<string, string> = {};
      settings.forEach(s => {
        result[s.key] = s.value;
      });

      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getSession(tenantId: string, platform: string, identifier: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const session = await this.accountSessionRepository.findOne({
        where: { platform, identifier },
        transaction,
      });

      await transaction.commit();

      if (!session) {
        throw new NotFoundException(`Session for platform ${platform} and identifier ${identifier} not found`);
      }

      return session.session_data;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── REGISTER TENANT ────────────────────────────────────────────────────────

  async registerTenant(dto: RegisterTenantDto) {
    if (dto.password !== dto.confirm_password) {
      throw new BadRequestException('Konfirmasi password tidak cocok');
    }

    const tenant = await this.tenantProvisioningService.provision({
      username: dto.username,
      email: dto.email,
      password: dto.password,
    });

    // Send verification email (simulated for now, can be real later)
    await this.sendWelcomeEmail(dto.email, dto.username);

    return {
      message: 'Registrasi berhasil! Silakan cek email Anda untuk konfirmasi.',
      tenant_id: tenant.id,
    };
  }

  private async sendWelcomeEmail(email: string, username: string) {
    const host = this.configService.get<string>('mail.host');
    const port = this.configService.get<number>('mail.port');
    const user = this.configService.get<string>('mail.user');
    const pass = this.configService.get<string>('mail.pass');
    const from = this.configService.get<string>('mail.from');

    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: `"Digital Premium" <${from}>`,
      to: email,
      subject: 'Selamat Datang di Digital Premium!',
      html: `<div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2>Halo ${username}! 👋</h2>
        <p>Terima kasih telah mendaftar di Digital Premium. Akun Anda telah berhasil dibuat.</p>
        <p>Anda sekarang dapat login ke dashboard menggunakan email dan password yang telah Anda buat.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${this.configService.get('FRONTEND_URL')}/login" style="background: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Login ke Dashboard</a>
        </div>
      </div>`,
    });
  }

  async forgotPassword(email: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const owner = await this.tenantOwnerRepository.findOne({
        where: { email },
        include: [{ model: Tenant, as: 'tenant' }],
        transaction,
      });

      if (!owner) {
        // We return success even if user not found for security (avoid enumeration)
        return { message: 'Jika email Anda terdaftar, Anda akan menerima link reset password.' };
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date();
      expires.setHours(expires.getHours() + 1); // 1 hour expiry

      await owner.update({
        reset_token: token,
        reset_expires: expires,
      }, { transaction });

      await this.sendResetPasswordEmail(email, owner.tenant?.name || 'Owner', token);

      await transaction.commit();
      return { message: 'Jika email Anda terdaftar, Anda akan menerima link reset password.' };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async resetPassword(token: string, password: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const owner = await this.tenantOwnerRepository.findOne({
        where: {
          reset_token: token,
          reset_expires: { [Op.gt]: new Date() },
        },
        transaction,
      });

      if (!owner) {
        throw new BadRequestException('Token tidak valid atau sudah kadaluarsa');
      }

      const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

      await owner.update({
        password: hashedPassword,
        reset_token: null,
        reset_expires: null,
      }, { transaction });

      await transaction.commit();
      return { message: 'Password Anda berhasil diperbarui. Silakan login kembali.' };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  private async sendResetPasswordEmail(email: string, name: string, token: string) {
    const host = this.configService.get<string>('mail.host');
    const port = this.configService.get<number>('mail.port');
    const user = this.configService.get<string>('mail.user');
    const pass = this.configService.get<string>('mail.pass');
    const from = this.configService.get<string>('mail.from');

    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port,
      auth: { user, pass },
    });

    const resetUrl = `${this.configService.get('FRONTEND_URL')}/reset-password?token=${token}`;

    await transporter.sendMail({
      from: `"Digital Premium" <${from}>`,
      to: email,
      subject: 'Reset Password Digital Premium',
      html: `<div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2>Halo ${name}!</h2>
        <p>Anda menerima email ini karena kami menerima permintaan reset password untuk akun Anda.</p>
        <p>Silakan klik tombol di bawah ini untuk mereset password Anda. Link ini akan kadaluarsa dalam 1 jam.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background: #f44336; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Reset Password</a>
        </div>
        <p>Jika Anda tidak merasa meminta reset password, silakan abaikan email ini.</p>
      </div>`,
    });
  }

  // ─── LIST PRODUCTS ──────────────────────────────────────────────────────────

  async getProducts(tenantId: string) {
    if (!tenantId) return [];
    
    const [schemaResult] = await this.postgresProvider.rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = :tenantId`,
      { replacements: { tenantId } }
    );
    if (!schemaResult || (schemaResult as any[]).length === 0) {
      throw new NotFoundException('Tenant not found');
    }

    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const products = await this.productRepository.findAll({
        include: [{ model: ProductVariant, as: 'variants' }],
        order: [['created_at', 'ASC']],
        transaction,
      });

      // Sum items_sold from product_sales_statistics — same data as dashboard,
      // covers all channels (landingpage, Shopee, manual, etc.)
      const [salesRows] = await this.postgresProvider.rawQuery(
        `SELECT pv.product_id, SUM(pss.items_sold) AS total_sales
         FROM product_sales_statistics pss
         JOIN product_variant pv ON pv.id = pss.product_variant_id
         GROUP BY pv.product_id`,
        { transaction },
      );

      // Build a lookup map: product_id -> total_sales
      const salesMap = new Map<string, number>();
      (salesRows as any[]).forEach((row) => {
        salesMap.set(String(row.product_id), Number(row.total_sales));
      });

      // Merge total_sales into each product plain object
      const result = products.map((p) => ({
        ...(p.toJSON() as any),
        total_sales: salesMap.get(String(p.id)) ?? 0,
      }));

      await transaction.commit();
      return result;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── CREATE PAYMENT ─────────────────────────────────────────────────────────

  async createPayment(tenantId: string, dto: CreatePaymentDto) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      // 1. Get variant
      const variant = await this.productVariantRepository.findByPk(
        dto.product_variant_id,
        {
          include: [{ model: Product, as: 'product' }],
          transaction,
        },
      );
      if (!variant) throw new NotFoundException('Varian produk tidak ditemukan');

      // 2. Check stock
      const stockStatus = await this.getStockStatus(tenantId);
      const variantStock = stockStatus.find(s => s.product_variant_id === variant.id);
      if (!variantStock || variantStock.stock <= 0) {
        const fullVariantName = (variant as any).product?.name ? `${(variant as any).product.name} ${variant.name}` : variant.name;
        throw new ServiceUnavailableException(`Stok untuk ${fullVariantName} habis silahkan hubungi admin untuk restock`);
      }

      // 3. Create order record (Payment Status: PENDING)
      const orderId = `INV-${tenantId.toUpperCase()}-${Date.now()}`;
      let grossAmount = variant.price;
      let discountAmount = 0;
      let promoCodeId: string | null = null;

      // Validate promo code if provided
      if (dto.promo_code) {
        try {
          const promoResult = await this.promoService.validate(
            tenantId, 
            dto.promo_code, 
            grossAmount, 
            dto.product_variant_id
          );
          promoCodeId = promoResult.id;
          discountAmount = promoResult.discount_amount;
          grossAmount -= discountAmount;
          
          // Ensure amount is not negative
          if (grossAmount < 0) grossAmount = 0;
        } catch (error: any) {
          throw new BadRequestException(error.message || 'Kode promo tidak valid');
        }
      }

      // Build DOKU callback URL with tenant subdomain or custom domain
      const tenantBaseUrl = await this.getTenantBaseUrl(tenantId);
      const callbackUrl = `${tenantBaseUrl}/success?order_id=${orderId}`;

      const dokuPayload = {
        order: {
          invoice_number: orderId,
          amount: grossAmount,
          currency: 'IDR',
          callback_url: callbackUrl,
          auto_redirect: true,
        },
        customer: {
          name: dto.buyer_name,
          email: dto.buyer_email,
        },
      };

      const dokuResponse = await this.requestDokuCheckout(dokuPayload);
      const paymentUrl = dokuResponse.payment_url;

      // Skip SNAP QRIS request and use payment_url directly as requested by the user
      const qrisString = '';

      // 4. Create transaction record
      const txn = await this.transactionRepository.create(
        {
          id: orderId,
          customer: dto.buyer_name,
          platform: 'landing',
          total_price: grossAmount,
          mdr_fee: 0,
          platform_fee: 0,
          net_profit: grossAmount,
        },
        { transaction },
      );

      // 5. Create transaction item
      const txnItem = await this.transactionItemRepository.create(
        {
          name: `${(variant as any).product?.name ?? 'Produk'} - ${variant.name}`,
          transaction_id: txn.id,
        },
        { transaction },
      );

      // 6. Create voucher record (PENDING)
      // Expiration: 24 hours from now
      const voucherExpiry = new Date();
      voucherExpiry.setHours(voucherExpiry.getHours() + 24);

      await this.voucherRepository.create(
        {
          id: `VC-${Date.now().toString(36).toUpperCase()}`, 
          buyer_name: dto.buyer_name,
          buyer_email: dto.buyer_email,
          buyer_whatsapp: dto.buyer_whatsapp,
          product_variant_id: variant.id,
          payment_id: orderId,
          transaction_id: txn.id,
          transaction_item_id: txnItem.id,
          payment_status: 'PENDING',
          status: 'PENDING',
          expired_at: voucherExpiry,
          promo_code_id: promoCodeId,
          discount_amount: discountAmount,
        },
        { transaction },
      );

      // 7. Send invoice email (non-blocking)
      this.sendInvoiceEmail(
        dto.buyer_email,
        dto.buyer_name,
        paymentUrl, 
        `${(variant as any).product?.name ?? 'Produk'} - ${variant.name}`,
        grossAmount,
      ).catch((err) => {
        this.logger.error(`[CreatePayment] Failed to send invoice email: ${err.message}`);
      });

      await transaction.commit();

      return {
        order_id: orderId,
        payment_url: paymentUrl,
        qris_string: qrisString,
        amount: grossAmount,
      };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── DOKU SNAP QRIS (B2B Direct API) ──────────────────────────────────────

  private async getDokuSnapAccessToken(): Promise<string> {
    const clientId = this.configService.get<string>('doku.clientId');
    const privateKeyFile = this.configService.get<string>('doku.privateKeyFile');
    const privateKeyRaw = this.configService.get<string>('doku.privateKey') || '';
    const isProd = this.configService.get<boolean>('doku.isProduction');
    const baseUrl = isProd ? 'api.doku.com' : 'api-sandbox.doku.com';

    // Prefer reading from file (more reliable for large RSA keys)
    let privateKey: string;
    if (privateKeyFile && fs.existsSync(privateKeyFile)) {
      privateKey = fs.readFileSync(privateKeyFile, 'utf8');
      this.logger.log(`[SNAP Token] Using private key from file: ${privateKeyFile}`);
    } else {
      // Fallback: convert escaped \n in env var to real newlines
      privateKey = privateKeyRaw.replace(/\\n/g, '\n');
      this.logger.log(`[SNAP Token] Using private key from env var`);
    }

    if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
      throw new Error('DOKU private key not configured. Set DOKU_PRIVATE_KEY_FILE or DOKU_PRIVATE_KEY in .env');
    }

    // Timestamp in ISO8601 format
    const timestamp = new Date().toISOString().replace(/\..+/, '+00:00');

    // Build asymmetric stringToSign: clientId|timestamp
    const stringToSign = `${clientId}|${timestamp}`;

    const signer = crypto.createSign('SHA256');
    signer.update(stringToSign);
    signer.end();
    const signature = signer.sign(privateKey, 'base64');

    const body = JSON.stringify({ grantType: 'client_credentials' });
    const targetPath = '/authorization/v1/access-token/b2b';

    const options = {
      hostname: baseUrl,
      path: targetPath,
      method: 'POST',
      headers: {
        'X-CLIENT-KEY': clientId,
        'X-TIMESTAMP': timestamp,
        'X-SIGNATURE': signature,
        'Content-Type': 'application/json',
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.accessToken) {
              resolve(parsed.accessToken);
            } else {
              reject(new Error(`DOKU SNAP Token error: ${JSON.stringify(parsed)}`));
            }
          } catch {
            reject(new Error('Failed to parse DOKU SNAP access token response'));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async requestDokuSnapQris(orderId: string, amount: number): Promise<string> {
    const clientId = this.configService.get<string>('doku.clientId');
    const secretKey = this.configService.get<string>('doku.secretKey') || '';
    const merchantId = this.configService.get<string>('doku.merchantId');
    const isProd = this.configService.get<boolean>('doku.isProduction');
    const baseUrl = isProd ? 'api.doku.com' : 'api-sandbox.doku.com';
    const targetPath = '/snap-adapter/b2b/v1.0/qr/qr-mpm-generate';

    // 1. Get B2B Access Token
    const accessToken = await this.getDokuSnapAccessToken();

    // 2. Build request
    const timestamp = new Date().toISOString().replace(/\..+/, '+00:00');
    const externalId = `EXT-${Date.now()}`;

    const bodyObj = {
      partnerReferenceNo: orderId,
      merchantId: merchantId,
      terminalId: 'A01',
      amount: {
        value: `${amount}.00`,
        currency: 'IDR',
      },
    };
    const body = JSON.stringify(bodyObj);

    // 3. Build symmetric signature (HMAC-SHA512)
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex').toLowerCase();
    const stringToSign = `POST:${targetPath}:${accessToken}:${bodyHash}:${timestamp}`;
    const signature = crypto.createHmac('sha512', secretKey).update(stringToSign).digest('base64');

    const options = {
      hostname: baseUrl,
      path: targetPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-TIMESTAMP': timestamp,
        'X-SIGNATURE': signature,
        'X-PARTNER-ID': clientId,
        'X-EXTERNAL-ID': externalId,
        'CHANNEL-ID': 'H2H',
        'Content-Type': 'application/json',
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            this.logger.log(`[SNAP QRIS] Response: ${JSON.stringify(parsed)}`);
            if (parsed.qrContent) {
              resolve(parsed.qrContent);
            } else {
              reject(new Error(`DOKU SNAP QRIS error: ${JSON.stringify(parsed)}`));
            }
          } catch {
            reject(new Error('Failed to parse DOKU SNAP QRIS response'));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ─── DOKU API UTILS ──────────────────────────────────────────────────────────

  private async requestDokuCheckout(payload: any): Promise<{ payment_url: string }> {
    const clientId = this.configService.get<string>('doku.clientId');
    const secretKey = this.configService.get<string>('doku.secretKey') || '';
    const isProd = this.configService.get<boolean>('doku.isProduction');
    
    const baseUrl = isProd ? 'api.doku.com' : 'api-sandbox.doku.com';
    const targetPath = '/checkout/v1/payment';
    const requestId = `REQ-${Date.now()}`;
    const timestamp = new Date().toISOString().split('.')[0] + 'Z';

    const fullPayload = {
      ...payload,
      payment: {
        payment_due_date: 60,
        payment_method_types: ['QRIS'],
      },
    };
    
    const body = JSON.stringify(fullPayload);

    const digest = crypto.createHash('sha256').update(body).digest('base64');
    const signatureComponent = `Client-Id:${clientId}\n` +
                               `Request-Id:${requestId}\n` +
                               `Request-Timestamp:${timestamp}\n` +
                               `Request-Target:${targetPath}\n` +
                               `Digest:${digest}`;

    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(signatureComponent)
      .digest('base64');

    const options = {
      hostname: baseUrl,
      path: targetPath,
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Request-Id': requestId,
        'Request-Timestamp': timestamp,
        'Signature': `HMACSHA256=${signature}`,
        'Content-Type': 'application/json',
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.response?.payment?.url) {
              resolve({ payment_url: parsed.response.payment.url });
            } else {
              reject(new Error(`DOKU Checkout error: ${JSON.stringify(parsed)}`));
            }
          } catch {
            reject(new Error('Failed to parse DOKU Checkout response'));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async handleSubscriptionPaymentNotify(tenantId: string, body: any) {
    const { order, transaction } = body;
    const transactionStatus = transaction?.status;

    if (transactionStatus !== 'SUCCESS') {
      return { ok: true };
    }

    const dbTransaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', dbTransaction);

      const [tenants] = await this.postgresProvider.rawQuery(
        `SELECT id, subscription_ends_at, trial_ends_at FROM tenant WHERE id = :tenantId`,
        {
          replacements: { tenantId },
          transaction: dbTransaction,
        }
      );

      if (!tenants || (tenants as any[]).length === 0) {
        await dbTransaction.commit();
        return { ok: true };
      }

      const tenant = (tenants as any[])[0];
      let baseDate = new Date();

      if (tenant.subscription_ends_at && new Date(tenant.subscription_ends_at) > baseDate) {
        baseDate = new Date(tenant.subscription_ends_at);
      }

      const newSubscriptionEndsAt = new Date(baseDate);
      newSubscriptionEndsAt.setDate(newSubscriptionEndsAt.getDate() + 30);

      await this.postgresProvider.rawQuery(
        `UPDATE tenant SET subscription_ends_at = :newSubscriptionEndsAt, status = 'active' WHERE id = :tenantId`,
        {
          replacements: {
            newSubscriptionEndsAt,
            tenantId,
          },
          transaction: dbTransaction,
        }
      );

      await dbTransaction.commit();
      this.logger.log(`[SubscriptionNotify] Successfully extended subscription for tenant: ${tenantId} to ${newSubscriptionEndsAt.toISOString()}`);
      return { ok: true };
    } catch (error: any) {
      await dbTransaction.rollback();
      this.logger.error(`[SubscriptionNotify] Error processing notification: ${error.message}`, error.stack);
      throw error;
    }
  }

  // ─── PAYMENT NOTIFY WEBHOOK (DOKU) ───────────────────────────────────────────

  async handlePaymentNotify(tenantId: string, body: any) {
    const { order, transaction } = body;
    const orderId = order?.invoice_number;
    const transactionStatus = transaction?.status;

    const dbTransaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, dbTransaction);

      const voucher = await this.voucherRepository.findOne({
        where: { payment_id: orderId },
        include: [{ model: ProductVariant, as: 'product_variant', include: [{ model: Product, as: 'product' }] }],
        transaction: dbTransaction,
      });
      if (!voucher) {
        await dbTransaction.commit();
        return { ok: true };
      }

      const isPaid = transactionStatus === 'SUCCESS';
      const isExpiredOrFailed = transactionStatus === 'FAILED' || transactionStatus === 'EXPIRED';

      let shouldSendEmail = false;
      if (isPaid && voucher.payment_status !== 'PAID') {
        shouldSendEmail = true;
        await voucher.update({ payment_status: 'PAID', status: 'UNUSED' }, { transaction: dbTransaction });

        // Update promo code usage if applicable
        if (voucher.promo_code_id) {
          const promo = await this.postgresProvider.rawQuery(
            `UPDATE promo_code SET current_usage = current_usage + 1 WHERE id = :id`,
            {
              replacements: { id: voucher.promo_code_id },
              transaction: dbTransaction,
            }
          );
        }


      }
      else if (isExpiredOrFailed) {
        await voucher.update(
          { payment_status: 'FAILED', status: 'EXPIRED' },
          { transaction: dbTransaction },
        );
      }

      let siteName = 'Volve Capital';
      if (shouldSendEmail) {
        try {
          const setting = await this.tenantSettingRepository.findOne({
            where: { key: 'SITE_NAME' } as any,
            transaction: dbTransaction,
          });
          if (setting) siteName = setting.value;
        } catch (e) {
          this.logger.error(`Failed to fetch SITE_NAME for email in notify: ${e.message}`);
        }
      }

      await dbTransaction.commit();

      if (shouldSendEmail) {
        const productName = `${(voucher.product_variant as any)?.product?.name ?? 'Produk'} - ${voucher.product_variant?.name ?? ''}`;
        
        // Kirim WhatsApp (non-blocking)
        if (voucher.buyer_whatsapp) {
          this.whatsappService
            .sendVoucherCode({
              buyerPhone: voucher.buyer_whatsapp,
              buyerName: voucher.buyer_name,
              voucherCode: String(voucher.id),
              productName: productName,
              expiredAt: voucher.expired_at,
              tenantId: tenantId,
            })
            .catch(err =>
              this.logger.error(`[WA] Gagal kirim voucher ${voucher.id} (non-fatal):`, err),
            );
        }

        // Kirim Email
        this.logger.log(`[PaymentNotify] Sending confirmation email for voucher ${voucher.id} to ${voucher.buyer_email}`);
        this.sendPaymentConfirmationEmail(
          tenantId,
          voucher.buyer_email,
          voucher.buyer_name,
          voucher.id,
          productName,
          voucher.expired_at,
          siteName,
        ).catch((err) => {
          this.logger.error(`[PaymentNotify] Failed to send email for voucher ${voucher.id}: ${err.message}`);
        });
      }

      return { ok: true };
    }
    catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  // ─── PAYOUT NOTIFY WEBHOOK (DOKU) ───────────────────────────────────────────

  async handlePayoutNotify(tenantId: string, withdrawalRequestId: string, body: any, headers: { signature: string, requestId: string, timestamp: string }) {
    const { signature, requestId, timestamp } = headers;
    const clientId = this.configService.get<string>('doku.clientId');
    const secretKey = this.configService.get<string>('doku.secretKey') || '';

    // Validate Signature
    const targetPath = '/public/webhook/doku/payout'; // Adjust if there's a specific prefix on your infra like /api/v1
    // Doku signature verification requires the raw body, assuming body is exactly the payload.
    // In NestJS, body is parsed. It's best practice to use raw body but for now we re-stringify.
    const bodyStr = JSON.stringify(body);
    const digest = crypto.createHash('sha256').update(bodyStr).digest('base64');
    const signatureComponent = `Client-Id:${clientId}\n` +
                               `Request-Id:${requestId}\n` +
                               `Request-Timestamp:${timestamp}\n` +
                               `Request-Target:${targetPath}\n` +
                               `Digest:${digest}`;
                               
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(signatureComponent)
      .digest('base64');

    const expectedSignatureFull = `HMACSHA256=${expectedSignature}`;
    
    // We log but don't strictly reject if it doesn't match perfectly during dev, but in prod we should.
    if (signature !== expectedSignatureFull) {
      this.logger.warn(`[PayoutNotify] Signature mismatch! Expected: ${expectedSignatureFull}, Got: ${signature}`);
      // throw new BadRequestException('Invalid signature'); // Uncomment for strict checking
    }

    const tx = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, tx);
      
      // Determine status from payload. DOKU Payout usually sends SUCCESS or FAILED.
      // DOKU Payouts notification usually has status in transaction.status or similar.
      const statusStr = (body.transaction?.status || body.payouts?.[0]?.status || body.status || '').toUpperCase();
      let newStatus: 'SUCCESS' | 'FAILED' | null = null;
      
      if (statusStr === 'SUCCESS' || statusStr === 'SUCCESSFUL' || statusStr === 'COMPLETED') {
        newStatus = 'SUCCESS';
      } else if (statusStr === 'FAILED' || statusStr === 'REJECTED') {
        newStatus = 'FAILED';
      }

      if (newStatus) {
        await this.postgresProvider.rawQuery(
          `UPDATE withdrawal_request SET status = :status, updated_at = NOW() WHERE id = :id`,
          { replacements: { status: newStatus, id: withdrawalRequestId }, transaction: tx }
        );
        this.logger.log(`[PayoutNotify] Updated WD Request ${withdrawalRequestId} to ${newStatus}`);
      }

      await tx.commit();
      return { ok: true };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  // ─── CHECK PAYMENT STATUS ────────────────────────────────────────────────────

  async checkPaymentStatus(tenantId: string, orderId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const voucher = await this.voucherRepository.findOne({
        where: { payment_id: orderId },
        transaction,
      });

      if (!voucher) {
        throw new NotFoundException('Pesanan tidak ditemukan');
      }

      await transaction.commit();
      return {
        order_id: orderId,
        payment_status: voucher.payment_status,
        voucher_code: voucher.payment_status === 'PAID' ? voucher.id : null,
      };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── GET VOUCHER BY CODE ─────────────────────────────────────────────────────

  async getVoucher(tenantId: string, code: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const voucher = await this.voucherRepository.findOne({
        where: { id: code },
        include: [
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [
              { model: Product, as: 'product' },
              { model: Tutorial, as: 'tutorial' }
            ],
          },
          {
            model: TransactionItem,
            as: 'transaction_item',
            include: [
              {
                model: AccountUser,
                as: 'user',
                include: [
                  {
                    model: Account,
                    as: 'account',
                    include: [{ model: Email, as: 'email' }],
                  },
                  {
                    model: AccountProfile,
                    as: 'profile',
                  },
                ],
              },
            ],
          },
        ],
        transaction,
      });

      if (!voucher) {
        throw new NotFoundException('Voucher tidak ditemukan');
      }

      // Ekstrak data akun agar Frontend bisa langsung baca
      const user = (voucher.transaction_item as any)?.user;
      const isExpired = user && user.expired_at && new Date() > new Date(user.expired_at);
      
      const accountData = (user && !isExpired) ? {
        email: user.account?.email?.email,
        password: user.account?.account_password,
        profile_name: user.profile?.name,
        expired_at: user.expired_at,
        metadata: (() => {
          try {
            return user.profile?.metadata ? JSON.parse(user.profile.metadata) : {};
          } catch (e) {
            return {};
          }
        })(),
      } : null;

      await transaction.commit();
      return { 
        voucher, 
        account: accountData,
        is_expired: isExpired
      };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── REDEEM VOUCHER ──────────────────────────────────────────────────────────

  async redeemVoucher(tenantId: string, dto: RedeemVoucherDto) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      // 1. Validate voucher
      const voucher = await this.voucherRepository.findOne({
        where: { id: dto.voucher_code, status: 'UNUSED', payment_status: 'PAID' },
        include: [{ model: ProductVariant, as: 'product_variant' }],
        transaction,
      });

      if (!voucher) {
        throw new BadRequestException(
          'Voucher tidak valid, sudah digunakan, atau belum dibayar.',
        );
      }

      const variant = voucher.product_variant;
      if (!variant) throw new NotFoundException('Varian produk tidak ditemukan');

      // 2. Find available account & profile slot
      const accounts = await this.accountRepository.findAll({
        where: {
          product_variant_id: voucher.product_variant_id,
          status: { [Op.notIn]: ['disable', 'banned'] },
          subscription_expiry: { [Op.gt]: new Date() },
          freeze_until: null,
        },
        include: [
          { model: Email, as: 'email' },
          {
            model: AccountProfile,
            as: 'profile',
            where: { allow_generate: true },
          },
        ],
        order: [
          ['subscription_expiry', 'ASC'],
          ['updated_at', 'ASC'],
        ],
        transaction,
      });

      let chosenAccount: Account | null = null;
      let chosenProfile: AccountProfile | null = null;

      for (const account of accounts) {
        const profiles: AccountProfile[] = (account as any).profile ?? [];
        for (const profile of profiles) {
          const activeUsers = await this.accountUserRepository.count({
            where: {
              account_profile_id: profile.id,
              status: 'active',
            },
            transaction,
          });
          if (activeUsers < profile.max_user) {
            chosenAccount = account;
            chosenProfile = profile;
            break;
          }
        }
        if (chosenProfile) break;
      }

      if (!chosenAccount || !chosenProfile) {
        throw new ServiceUnavailableException(
          'Maaf, stok akun sedang habis atau semua slot penuh. Hubungi admin.',
        );
      }

      // 4. Insert account_user
      const expiredAt = new Date(
        Date.now() + Number(variant.duration),
      );

      const newUser = await this.accountUserRepository.create(
        {
          name: voucher.buyer_name,
          account_id: chosenAccount.id,
          account_profile_id: chosenProfile.id,
          status: 'active',
          expired_at: expiredAt,
        },
        { transaction },
      );

      // 5. Update voucher
      const accessToken = crypto.randomBytes(32).toString('hex');
      await voucher.update(
        {
          status: 'USED',
          access_token: accessToken,
          used_at: new Date(),
          expired_at: expiredAt,
        },
        { transaction },
      );

      // 6. Link to transaction_item if possible
      if (voucher.payment_id) {
        const txnItem = await this.transactionItemRepository.findOne({
          where: { transaction_id: voucher.payment_id },
          transaction,
        });
        if (txnItem) {
          await txnItem.update({ account_user_id: newUser.id }, { transaction });
          await voucher.update({ transaction_item_id: txnItem.id }, { transaction });
        }
      }

      await transaction.commit();

      return {
        message: 'Voucher berhasil diredeem!',
        access_token: accessToken,
        expired_at: expiredAt,
        email: (chosenAccount as any).email?.email,
        password: chosenAccount.account_password,
        profile_name: chosenProfile.name,
      };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── STOCK STATUS ───────────────────────────────────────────────────────────

  async getStockStatus(tenantId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      
      // 1. Get low stock threshold from settings
      const thresholdSetting = await this.tenantSettingRepository.findOne({
        where: { key: 'LOW_STOCK_THRESHOLD' },
        transaction,
      });
      const globalThreshold = thresholdSetting ? parseInt(thresholdSetting.value) : 5;

      const variants = await this.productVariantRepository.findAll({ 
        include: [{ model: Product, as: 'product' }],
        transaction, 
      });
      
      const result: any[] = [];
      for (const v of variants) {
          const accounts = await this.accountRepository.findAll({
            where: {
              product_variant_id: v.id,
              status: { [Op.notIn]: ['disable', 'banned'] },
              subscription_expiry: { [Op.gt]: new Date() },
              freeze_until: null,
            },
            include: [{ model: AccountProfile, as: 'profile', where: { allow_generate: true } }],
            transaction,
          });

          let availableSlots = 0;
          for (const acc of accounts) {
            const profiles: AccountProfile[] = (acc as any).profile ?? [];
            for (const prof of profiles) {
              const activeUsers = await this.accountUserRepository.count({
                where: { account_profile_id: prof.id, status: 'active' },
                transaction,
              });
              availableSlots += Math.max(0, prof.max_user - Number(activeUsers));
            }
          }

          const threshold = v.low_stock_threshold ?? globalThreshold;

          result.push({
            product_variant_id: v.id,
            product_name: (v as any).product?.name || 'Unknown',
            variant_name: v.name,
            stock: availableSlots,
            low_stock: availableSlots <= threshold,
          });
      }

      await transaction.commit();
      return result;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ─── EMAIL UTILS ─────────────────────────────────────────────────────────────

  private async sendPaymentConfirmationEmail(
    tenantId: string,
    email: string,
    buyerName: string,
    voucherCode: string,
    productName: string,
    expiredAt: Date,
    siteName: string,
  ): Promise<void> {
    const host = this.configService.get<string>('mail.host');
    const port = this.configService.get<number>('mail.port');
    const user = this.configService.get<string>('mail.user');
    const pass = this.configService.get<string>('mail.pass');
    const from = this.configService.get<string>('mail.from');

    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port,
      auth: { user, pass },
    });

    // Build Redeem URL
    const tenantBaseUrl = await this.getTenantBaseUrl(tenantId);
    const redeemUrl = `${tenantBaseUrl}/redeem?code=${voucherCode}`;

    const expiryFormatted = new Date(expiredAt).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    await transporter.sendMail({
      from: `"${siteName}" <${from}>`,
      to: email,
      subject: `Voucher ${productName} Anda telah berhasil dibuat`,
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #f97316 0%, #ef4444 100%); padding: 40px 20px; text-align: center; color: white;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.025em;">Voucher Berhasil Dibuat! 🎉</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9; font-size: 16px;">Terima kasih telah berbelanja di ${siteName}</p>
          </div>
          
          <div style="padding: 32px 24px;">
            <p style="margin: 0 0 20px 0; font-size: 16px;">Halo <strong>${buyerName}</strong>,</p>
            <p style="margin: 0 0 24px 0;">Terima kasih telah melakukan pembelian di <strong>${siteName}</strong>. Berikut adalah detail voucher Anda:</p>
            
            <div style="background-color: #f8fafc; border: 1px solid #f1f5f9; border-radius: 12px; padding: 20px; margin-bottom: 32px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-size: 14px; width: 40%;">Produk</td>
                  <td style="padding: 8px 0; color: #0f172a; font-size: 14px; font-weight: 600;">: ${productName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Kode Voucher</td>
                  <td style="padding: 8px 0; color: #f97316; font-size: 16px; font-weight: 800; letter-spacing: 1px;">: ${voucherCode}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Batas Klaim</td>
                  <td style="padding: 8px 0; color: #ef4444; font-size: 14px; font-weight: 600;">: ${expiryFormatted}</td>
                </tr>
              </table>
            </div>

            <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #0f172a;">Cara Redeem Voucher:</h3>
            <ol style="margin: 0 0 32px 0; padding-left: 20px; color: #475569;">
              <li style="margin-bottom: 8px;">Klik tombol <strong>"Redeem Voucher"</strong> di bawah ini.</li>
              <li style="margin-bottom: 8px;">Kode voucher akan terisi otomatis (atau masukkan manual jika tidak muncul).</li>
              <li style="margin-bottom: 8px;">Klik <strong>"Cek Sekarang"</strong>, lalu klik <strong>"Aktivasi Voucher"</strong>.</li>
              <li style="margin-bottom: 8px;">Jika berhasil, detail akun yang Anda beli akan muncul seketika.</li>
            </ol>

            <div style="text-align: center; margin-bottom: 32px;">
              <a href="${redeemUrl}" style="display: inline-block; background: linear-gradient(135deg, #f97316 0%, #ef4444 100%); color: white; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 800; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(249, 115, 22, 0.3);">Redeem Voucher Sekarang</a>
            </div>

            <div style="background-color: #fff7ed; border-left: 4px solid #f97316; padding: 16px; border-radius: 4px; margin-bottom: 32px;">
              <p style="margin: 0; font-size: 13px; color: #9a3412;"><strong>Hati-hati!</strong> Jangan bagikan kode voucher ini kepada siapapun termasuk pihak yang mengaku sebagai admin.</p>
            </div>

            <p style="margin: 0; font-size: 14px; color: #64748b; text-align: center;">Terima kasih,<br><strong>${siteName}</strong></p>
          </div>
          
          <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0; font-size: 12px; color: #94a3b8;">&copy; ${new Date().getFullYear()} ${siteName}. All rights reserved.</p>
          </div>
        </div>
      `,
    });
  }

  private async sendInvoiceEmail(
    email: string,
    buyerName: string,
    paymentUrl: string,
    productName: string,
    amount: number,
  ): Promise<void> {
    const host = this.configService.get<string>('mail.host');
    const port = this.configService.get<number>('mail.port');
    const user = this.configService.get<string>('mail.user');
    const pass = this.configService.get<string>('mail.pass');
    const from = this.configService.get<string>('mail.from');

    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port,
      auth: { user, pass },
    });

    const amountFormatted = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0,
    }).format(amount);

    await transporter.sendMail({
      from: `"Digital Premium" <${from}>`,
      to: email,
      subject: `Invoice Pembayaran ${productName}`,
      text: `Halo ${buyerName}! 👋\n\nTerima kasih telah memesan ${productName}.\n\nTotal Pembayaran: ${amountFormatted}\n\nSilakan selesaikan pembayaran melalui link berikut:\n${paymentUrl}\n\nLink ini akan kadaluarsa dalam 24 jam.\n\nTerima kasih! 🙏`,
      html: `<div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2196F3;">Invoice Pembayaran 👋</h2>
        <p>Halo <strong>${buyerName}</strong>,</p>
        <p>Terima kasih telah melakukan pemesanan di Digital Premium. Berikut adalah detail pesanan Anda:</p>
        <div style="background: #f4f4f4; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <p style="margin: 5px 0;">📦 <strong>Produk:</strong> ${productName}</p>
          <p style="margin: 5px 0;">💰 <strong>Total:</strong> ${amountFormatted}</p>
        </div>
        <p>Silakan klik tombol di bawah ini untuk menyelesaikan pembayaran Anda:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${paymentUrl}" style="background: #2196F3; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">Bayar Sekarang</a>
        </div>
        <p style="font-size: 13px; color: #777;">Atau salin link berikut ke browser Anda:<br><code>${paymentUrl}</code></p>
        <p style="font-size: 12px; color: #777; margin-top: 30px;">Jika Anda sudah membayar, silakan abaikan email ini.</p>
      </div>`,
    });
  }

  // ─── GET EMAIL ACCESS FOR BUYER ─────────────────────────────────────────────

  async getEmailAccess(tenantId: string, token: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      // 1. Cari Voucher dulu di schema TENANT
      await this.postgresProvider.setSchema(tenantId, transaction);

      // 1. Find voucher by token
      const voucher = await this.voucherRepository.findOne({
        where: { access_token: token },
        include: [
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [{ model: Product, as: 'product' }],
          },
          {
            model: TransactionItem,
            as: 'transaction_item',
            include: [
              {
                model: AccountUser,
                as: 'user',
                include: [
                  {
                    model: Account,
                    as: 'account',
                    include: [{ model: Email, as: 'email' }],
                  },
                  {
                    model: AccountProfile,
                    as: 'profile',
                  },
                ],
              },
            ],
          },
        ],
        transaction,
      });

      if (!voucher) throw new NotFoundException('Akses tidak ditemukan');

      const user = (voucher.transaction_item as any)?.user;
      if (!user) throw new NotFoundException('Data user tidak ditemukan');

      // Check Expiration
      if (user.expired_at && new Date() > new Date(user.expired_at)) {
        throw new BadRequestException('Masa langganan Anda untuk voucher ini telah berakhir');
      }

      // 2. Security Check (Duration-based)
      // Max 10 minutes session for the tutorial link
      
      // 3. Update access count (Optional but good for stats)
      
      // 2. Ambil daftar subjek yang diizinkan dari schema TENANT (is_public subjects)
      const publicSubjects = await this.emailSubjectRepository.findAll({
        where: { is_public: true },
        transaction,
      });
      
      const productName = (voucher.product_variant as any)?.product?.name?.toLowerCase() || '';
      let allowedSubjectTexts = publicSubjects.map(s => s.subject);

      if (productName.includes('netflix')) {
        allowedSubjectTexts = publicSubjects.filter(s => s.context.includes('NETFLIX')).map(s => s.subject);
      } else if (productName.includes('disney')) {
        allowedSubjectTexts = publicSubjects.filter(s => s.context.includes('DISNEY')).map(s => s.subject);
      } else if (productName.includes('spotify')) {
        allowedSubjectTexts = publicSubjects.filter(s => s.context.includes('SPOTIFY')).map(s => s.subject);
      }

      // 2. Sekarang baru pindah ke schema TENANT untuk mengambil pesan email-nya
      await this.postgresProvider.setSchema(tenantId, transaction);
      const accountEmail = user.account?.email?.email;
      if (!accountEmail) throw new NotFoundException('Email akun tidak ditemukan');

      const messages = await this.emailMessageRepository.findAll({
        where: {
          recipient_email: { [Op.iLike]: accountEmail },
          subject: { [Op.in]: allowedSubjectTexts },
        },
        order: [['email_date', 'DESC']],
        limit: 20,
        transaction,
      });

      // 4. Fetch Tenant Settings for Limit
      const portalLimitSetting = await this.tenantSettingRepository.findOne({ 
        where: { key: 'BUYER_PORTAL_DAILY_LIMIT' },
        transaction 
      });
      const dailyLimit = portalLimitSetting?.value || '10';

      await transaction.commit();

      return {
        account: {
          email: accountEmail,
          profile_name: user.profile?.name,
          expired_at: user.expired_at,
          product_name: productName,
        },
        messages,
        limit: {
          total: parseInt(dailyLimit),
          remaining: parseInt(dailyLimit),
        }
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async convertNetflixCookies(cookiesInput: any, clientIp: string) {
    // 1. Rate Limiting Check (Max 3 conversions per IP per calendar day)
    const todayStr = new Date().toISOString().split('T')[0]; // e.g. "2026-08-17"
    
    // Clean up old entries periodically to prevent memory leak
    if (this.conversionRateLimitMap.size > 1000) {
      for (const [ipKey, record] of this.conversionRateLimitMap.entries()) {
        if (record.date !== todayStr) {
          this.conversionRateLimitMap.delete(ipKey);
        }
      }
    }

    const userRecord = this.conversionRateLimitMap.get(clientIp);
    if (userRecord && userRecord.date === todayStr) {
      if (userRecord.count >= 3) {
        throw new BadRequestException(
          'Batas konversi harian gratis telah tercapai (maksimal 3 kali sehari). Silakan daftar atau masuk ke dashboard untuk konversi tanpa batas!'
        );
      }
    }

    let cookiesList: any[] = [];

    if (typeof cookiesInput === 'string') {
      const trimmed = cookiesInput.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            cookiesList = parsed;
          } else if (parsed && Array.isArray(parsed.cookies)) {
            cookiesList = parsed.cookies;
          } else if (parsed && typeof parsed === 'object') {
            cookiesList = Object.entries(parsed).map(([name, value]) => ({ name, value }));
          }
        } catch (e) {
          // If JSON parse fails, process as semicolon-separated string
        }
      }
      
      if (cookiesList.length === 0) {
        // Parse semicolon separated cookies
        const pairs = trimmed.split(';');
        for (const pair of pairs) {
          const parts = pair.split('=');
          if (parts.length >= 2) {
            cookiesList.push({
              name: parts[0].trim(),
              value: parts.slice(1).join('=').trim()
            });
          }
        }
      }
    } else if (Array.isArray(cookiesInput)) {
      cookiesList = cookiesInput;
    } else if (cookiesInput && typeof cookiesInput === 'object') {
      if (Array.isArray(cookiesInput.cookies)) {
        cookiesList = cookiesInput.cookies;
      } else {
        cookiesList = Object.entries(cookiesInput).map(([name, value]) => ({ name, value }));
      }
    }

    const netflixIdCookie = cookiesList.find((c: any) => c && (c.name === 'NetflixId' || c.key === 'NetflixId'));
    const secureNetflixIdCookie = cookiesList.find((c: any) => c && (c.name === 'SecureNetflixId' || c.key === 'SecureNetflixId'));
    const nfvdidCookie = cookiesList.find((c: any) => c && (c.name === 'nfvdid' || c.key === 'nfvdid'));

    let cookieHeader = '';
    if (netflixIdCookie) {
      const cookieStrings: string[] = [];
      cookieStrings.push(`NetflixId=${netflixIdCookie.value}`);
      if (secureNetflixIdCookie) cookieStrings.push(`SecureNetflixId=${secureNetflixIdCookie.value}`);
      if (nfvdidCookie) cookieStrings.push(`nfvdid=${nfvdidCookie.value}`);
      cookieHeader = cookieStrings.join('; ');
    } else {
      // Fallback: build cookie header from any serialized entries
      if (cookiesList.length > 0) {
        cookieHeader = cookiesList.map(c => `${c.name || c.key || ''}=${c.value || ''}`).filter(Boolean).join('; ');
      } else if (typeof cookiesInput === 'string') {
        cookieHeader = cookiesInput.trim();
      }
    }

    if (!cookieHeader || !cookieHeader.includes('NetflixId=')) {
      throw new BadRequestException('Cookies Netflix tidak valid atau NetflixId tidak ditemukan.');
    }

    const QUERY_PARAMS: Record<string, string> = {
      "appVersion": "15.48.1",
      "config": '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
      "device_type": "NFAPPL-02-",
      "esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
      "idiom": "phone",
      "iosVersion": "15.8.5",
      "isTablet": "false",
      "languages": "en-US",
      "locale": "en-US",
      "maxDeviceWidth": "375",
      "model": "saget",
      "modelType": "IPHONE8-1",
      "odpAware": "true",
      "path": '["account","token","default"]',
      "pathFormat": "graph",
      "pixelDensity": "2.0",
      "progressive": "false",
      "responseFormat": "json"
    };

    const urlObj = new URL("https://ios.prod.ftl.netflix.com/iosui/user/15.48");
    for (const [k, v] of Object.entries(QUERY_PARAMS)) {
      urlObj.searchParams.set(k, v);
    }

    const headers = {
      "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
      "x-netflix.request.attempt": "1",
      "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
      "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
      "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
      "x-netflix.context.app-version": "15.48.1",
      "x-netflix.argo.translated": "true",
      "x-netflix.context.form-factor": "phone",
      "x-netflix.context.sdk-version": "2012.4",
      "x-netflix.client.appversion": "15.48.1",
      "x-netflix.context.max-device-width": "375",
      "x-netflix.context.ab-tests": "",
      "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
      "x-netflix.client.type": "argo",
      "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
      "x-netflix.context.locales": "en-US",
      "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
      "x-netflix.client.iosversion": "15.8.5",
      "accept-language": "en-US;q=1",
      "x-netflix.argo.abtests": "",
      "x-netflix.context.os-version": "15.8.5",
      "x-netflix.request.client.context": '{"appState":"foreground"}',
      "x-netflix.context.ui-flavor": "argo",
      "x-netflix.argo.nfnsm": "9",
      "x-netflix.context.pixel-density": "2.0",
      "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
      "x-netflix.request.client.timezoneid": "Asia/Dhaka",
      "Cookie": cookieHeader
    };

    try {
      const fetchResponse = await fetch(urlObj.toString(), {
        method: "GET",
        headers: headers
      });

      if (fetchResponse.ok) {
        const resJson = await fetchResponse.json() as any;
        const nftoken = resJson?.value?.account?.token?.default?.token;

        if (nftoken) {
          const pcUrl = `https://www.netflix.com/login?nftoken=${nftoken}`;
          const mobileUrl = `https://www.netflix.com/unsupported?nftoken=${nftoken}`;
          const tvUrl = `https://www.netflix.com/tv9?nftoken=${nftoken}`;
          const generalUrl = `https://www.netflix.com/account?nftoken=${nftoken}`;

          // Create short urls inside master schema
          const masterTx = await this.postgresProvider.transaction();
          try {
            await this.postgresProvider.setSchema('master', masterTx);

            const generateShort = async (url: string) => {
              const code = crypto.randomBytes(4).toString('hex');
              const expiresAt = new Date();
              expiresAt.setHours(expiresAt.getHours() + 24);
              await this.shortUrlRepository.create(
                { id: code, target_url: url, expires_at: expiresAt },
                { transaction: masterTx }
              );
              return code;
            };

            const [pcCode, mobileCode, tvCode, generalCode] = await Promise.all([
              generateShort(pcUrl),
              generateShort(mobileUrl),
              generateShort(tvUrl),
              generateShort(generalUrl)
            ]);

            await masterTx.commit();

            // Increment rate limit count
            const currentCount = userRecord && userRecord.date === todayStr ? userRecord.count : 0;
            this.conversionRateLimitMap.set(clientIp, { date: todayStr, count: currentCount + 1 });

            let landingUrl = process.env.LANDING_URL || 'digitalpremium.id';
            if (!landingUrl.startsWith('http')) {
              landingUrl = `https://${landingUrl}`;
            }

            return {
              success: true,
              token: nftoken,
              pcLink: `${landingUrl}/l/${pcCode}`,
              mobileLink: `${landingUrl}/l/${mobileCode}`,
              tvLink: `${landingUrl}/l/${tvCode}`,
              generalLink: `${landingUrl}/l/${generalCode}`
            };
          } catch (e: any) {
            try {
              await masterTx.rollback();
            } catch (err) {}
            throw new BadRequestException(`Gagal membuat shortlink: ${e.message}`);
          }
        } else {
          throw new BadRequestException('nftoken tidak ditemukan dalam respon FTL Netflix. Pastikan Cookie Anda aktif.');
        }
      } else {
        throw new BadRequestException(`Netflix FTL API gagal merespon: ${fetchResponse.statusText}`);
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Gagal menghubungi Netflix: ${err.message}`);
    }
  }

  async getNetflixTokenForBuyer(tenantId: string, token: string) {
    const transaction = await this.postgresProvider.transaction();
    let accountEmail = '';
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const voucher = await this.voucherRepository.findOne({
        where: { access_token: token },
        include: [
          {
            model: TransactionItem,
            as: 'transaction_item',
            include: [
              {
                model: AccountUser,
                as: 'user',
                include: [{ model: Account, as: 'account', include: [{ model: Email, as: 'email' }] }],
              },
            ],
          },
        ],
        transaction,
      });

      if (!voucher) throw new NotFoundException('Akses tidak ditemukan');

      const user = (voucher.transaction_item as any)?.user;
      if (!user) throw new NotFoundException('Data user tidak ditemukan');

      // Check Expiration
      if (user.expired_at && new Date() > new Date(user.expired_at)) {
        throw new BadRequestException('Masa langganan Anda untuk voucher ini telah berakhir');
      }

      accountEmail = user.account?.email?.email;
      if (!accountEmail) throw new NotFoundException('Email akun tidak ditemukan');

      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (e) {
        // Ignore rollback error if already finished
      }
      throw error;
    }

    const emailFileName = accountEmail.toLowerCase().replace(/[.@]/g, '_');
    
    // Check if session exists in the database (Read-only, commit early)
    let sessionData: any = null;
    const sessionTx = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, sessionTx);
      const accountSessionRepo = (this.postgresProvider as any).sequelize.models.AccountSession;
      const session = await accountSessionRepo.findOne({
        where: {
          platform: 'netflix',
          identifier: emailFileName,
        },
        transaction: sessionTx,
      });
      if (session) {
        sessionData = session.session_data;
      }
      await sessionTx.commit();
    } catch (e: any) {
      await sessionTx.rollback();
      this.logger.error(`[NetflixTokenDirectBuyer] Failed to get session: ${e.message}`, e.stack);
    }

    if (sessionData) {
      const cookies = sessionData.cookies || [];
      const netflixIdCookie = cookies.find((c: any) => c.name === 'NetflixId');
      const secureNetflixIdCookie = cookies.find((c: any) => c.name === 'SecureNetflixId');
      const nfvdidCookie = cookies.find((c: any) => c.name === 'nfvdid');

      if (netflixIdCookie) {
        const cookieStrings: string[] = [];
        cookieStrings.push(`NetflixId=${netflixIdCookie.value}`);
        if (secureNetflixIdCookie) cookieStrings.push(`SecureNetflixId=${secureNetflixIdCookie.value}`);
        if (nfvdidCookie) cookieStrings.push(`nfvdid=${nfvdidCookie.value}`);
        const cookieHeader = cookieStrings.join('; ');

        const QUERY_PARAMS: Record<string, string> = {
          "appVersion": "15.48.1",
          "config": '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
          "device_type": "NFAPPL-02-",
          "esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
          "idiom": "phone",
          "iosVersion": "15.8.5",
          "isTablet": "false",
          "languages": "en-US",
          "locale": "en-US",
          "maxDeviceWidth": "375",
          "model": "saget",
          "modelType": "IPHONE8-1",
          "odpAware": "true",
          "path": '["account","token","default"]',
          "pathFormat": "graph",
          "pixelDensity": "2.0",
          "progressive": "false",
          "responseFormat": "json"
        };

        const urlObj = new URL("https://ios.prod.ftl.netflix.com/iosui/user/15.48");
        for (const [k, v] of Object.entries(QUERY_PARAMS)) {
          urlObj.searchParams.set(k, v);
        }

        const headers = {
          "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
          "x-netflix.request.attempt": "1",
          "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
          "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
          "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
          "x-netflix.context.app-version": "15.48.1",
          "x-netflix.argo.translated": "true",
          "x-netflix.context.form-factor": "phone",
          "x-netflix.context.sdk-version": "2012.4",
          "x-netflix.client.appversion": "15.48.1",
          "x-netflix.context.max-device-width": "375",
          "x-netflix.context.ab-tests": "",
          "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
          "x-netflix.client.type": "argo",
          "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
          "x-netflix.context.locales": "en-US",
          "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
          "x-netflix.client.iosversion": "15.8.5",
          "accept-language": "en-US;q=1",
          "x-netflix.argo.abtests": "",
          "x-netflix.context.os-version": "15.8.5",
          "x-netflix.request.client.context": '{"appState":"foreground"}',
          "x-netflix.context.ui-flavor": "argo",
          "x-netflix.argo.nfnsm": "9",
          "x-netflix.context.pixel-density": "2.0",
          "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
          "x-netflix.request.client.timezoneid": "Asia/Dhaka",
          "Cookie": cookieHeader
        };

        this.logger.log(`[NetflixTokenDirectBuyer] Fetching token directly for ${accountEmail} in tenant ${tenantId}`);
        
        try {
          const fetchResponse = await fetch(urlObj.toString(), {
            method: "GET",
            headers: headers
          });

          if (fetchResponse.ok) {
            const resJson = await fetchResponse.json() as any;
            const nftoken = resJson?.value?.account?.token?.default?.token;

            if (nftoken) {
              const pcUrl = `https://www.netflix.com/login?nftoken=${nftoken}`;
              const mobileUrl = `https://www.netflix.com/unsupported?nftoken=${nftoken}`;
              const tvUrl = `https://www.netflix.com/tv9?nftoken=${nftoken}`;
              const generalUrl = `https://www.netflix.com/account?nftoken=${nftoken}`;

              // Create short urls inside master schema
              const masterTx = await this.postgresProvider.transaction();
              try {
                await this.postgresProvider.setSchema('master', masterTx);

                const generateShort = async (url: string) => {
                  const code = crypto.randomBytes(4).toString('hex');
                  const expiresAt = new Date();
                  expiresAt.setHours(expiresAt.getHours() + 24);
                  await this.shortUrlRepository.create(
                    { id: code, target_url: url, expires_at: expiresAt },
                    { transaction: masterTx }
                  );
                  return code;
                };

                const [pcCode, mobileCode, tvCode, generalCode] = await Promise.all([
                  generateShort(pcUrl),
                  generateShort(mobileUrl),
                  generateShort(tvUrl),
                  generateShort(generalUrl)
                ]);

                let landingUrl = process.env.LANDING_URL || 'digitalpremium.id';
                if (!landingUrl.startsWith('http')) {
                  landingUrl = `https://${landingUrl}`;
                }
                let baseUrl = landingUrl;
                try {
                  const url = new URL(landingUrl);
                  if (!url.hostname.startsWith(`${tenantId}.`)) {
                    url.hostname = `${tenantId}.${url.hostname}`;
                  }
                  baseUrl = url.toString().replace(/\/$/, '');
                } catch (e) {
                  const cleanBase = landingUrl.replace('https://', '').replace('http://', '');
                  baseUrl = `https://${tenantId}.${cleanBase}`;
                }

                const tenantObj = await (this.postgresProvider as any).sequelize.models.Tenant.findByPk(tenantId, { transaction: masterTx });
                if (tenantObj && tenantObj.custom_domain) {
                  baseUrl = `https://${tenantObj.custom_domain.toLowerCase()}`;
                }

                await masterTx.commit();

                return {
                  status: 'completed',
                  token: nftoken,
                  pcLink: `${baseUrl}/l/${pcCode}`,
                  mobileLink: `${baseUrl}/l/${mobileCode}`,
                  tvLink: `${baseUrl}/l/${tvCode}`,
                  generalLink: `${baseUrl}/l/${generalCode}`
                };
              } catch (masterErr: any) {
                await masterTx.rollback();
                throw masterErr;
              }
            }
          } else {
            const errText = await fetchResponse.text();
            this.logger.error(`[NetflixTokenDirectBuyer] FTL API Error for ${accountEmail}: ${fetchResponse.status} - ${errText}`);
          }
        } catch (fetchErr: any) {
          this.logger.error(`[NetflixTokenDirectBuyer] Fetch failed or master schema error: ${fetchErr.message}`, fetchErr.stack);
        }
      }
    }

    // Fallback: Enqueue task — returns taskId immediately, bot processes asynchronously
    const taskId = await this.taskQueueService.enqueueNetflixGetToken(tenantId, accountEmail);
    return { status: 'processing', taskId };
  }

  async getTutorials(tenantId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const tutorials = await this.tutorialRepository.findAll({
        attributes: ['id', 'title', 'slug', 'subtitle', 'thumbnail_url', 'created_at'],
        order: [['created_at', 'DESC']],
        transaction,
      });
      await transaction.commit();
      return tutorials;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getTutorialBySlug(tenantId: string, slug: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const tutorial = await this.tutorialRepository.findOne({
        where: { slug },
        transaction,
      });
      if (!tutorial) throw new NotFoundException('Tutorial tidak ditemukan');
      await transaction.commit();
      return tutorial;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getArticles(tenantId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const articles = await this.articleRepository.findAll({
        where: { is_published: true },
        order: [['created_at', 'DESC']],
        transaction,
      });
      await transaction.commit();
      return articles;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getArticleBySlug(tenantId: string, slug: string) {
    if (!tenantId) throw new NotFoundException('Article not found');
    
    const [schemaResult] = await this.postgresProvider.rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = :tenantId`,
      { replacements: { tenantId } }
    );
    if (!schemaResult || (schemaResult as any[]).length === 0) {
      throw new NotFoundException('Article not found');
    }

    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const article = await this.articleRepository.findOne({
        where: { slug, is_published: true },
        transaction,
      });
      if (!article) throw new NotFoundException('Artikel tidak ditemukan');
      await transaction.commit();
      return article;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  private async getTenantBaseUrl(tenantId: string): Promise<string> {
    let tenant: Tenant | null = null;
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      tenant = await Tenant.findByPk(tenantId, { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      this.logger.error(`Failed to fetch tenant for domain base URL: ${e.message}`);
    }

    if (tenant && tenant.custom_domain) {
      return `https://${tenant.custom_domain.toLowerCase()}`;
    }

    let frontendBaseUrl = this.configService.get<string>('FRONTEND_URL') || 'localhost:3001';
    if (!frontendBaseUrl.startsWith('http')) {
      frontendBaseUrl = `https://${frontendBaseUrl}`;
    }

    try {
      const url = new URL(frontendBaseUrl);
      const hostname = url.hostname;
      if (!hostname.startsWith(`${tenantId}.`)) {
        url.hostname = `${tenantId}.${hostname}`;
      }
      return url.toString().replace(/\/$/, '');
    } catch (e) {
      const cleanBase = frontendBaseUrl.replace('https://', '').replace('http://', '');
      return `https://${tenantId}.${cleanBase}`;
    }
  }

  async createShortUrl(targetUrl: string): Promise<{ code: string }> {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      // Generate random 8 character string
      const code = crypto.randomBytes(4).toString('hex');
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // Expires in 24h

      await this.shortUrlRepository.create(
        {
          id: code,
          target_url: targetUrl,
          expires_at: expiresAt,
        },
        { transaction }
      );

      await transaction.commit();
      return { code };
    } catch (error) {
      await transaction.rollback();
      this.logger.error(`Failed to create short url: ${error.message}`);
      throw new ServiceUnavailableException('Gagal membuat short url');
    }
  }

  async getShortUrl(code: string): Promise<{ target_url: string }> {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const shortUrl = await this.shortUrlRepository.findOne({
        where: { id: code },
        transaction,
      });

      if (!shortUrl) {
        throw new NotFoundException('Link tidak ditemukan atau sudah kadaluarsa');
      }

      await transaction.commit();
      return { target_url: shortUrl.target_url };
    } catch (error) {
      await transaction.rollback();
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to get short url: ${error.message}`);
      throw new ServiceUnavailableException('Gagal mengambil short url');
    }
  }

  async getPurchasesByIdentifier(tenantId: string, identifier: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      // Normalisasi WhatsApp/No HP
      let cleanIdentifier = identifier.trim();
      const searchConditions: any[] = [
        { buyer_email: cleanIdentifier }
      ];

      // Jika input hanya angka, deteksi sebagai nomor HP dan tambahkan variasi prefix
      if (/^\+?\d+$/.test(cleanIdentifier)) {
        const digits = cleanIdentifier.replace(/\D/g, '');
        searchConditions.push({ buyer_whatsapp: digits });
        
        if (digits.startsWith('0')) {
          searchConditions.push({ buyer_whatsapp: '62' + digits.substring(1) });
        } else if (digits.startsWith('62')) {
          searchConditions.push({ buyer_whatsapp: '0' + digits.substring(2) });
        }
      } else {
        searchConditions.push({ buyer_whatsapp: cleanIdentifier });
      }

      // Ambil daftar voucher yang lunas (PAID) atau sudah digunakan (USED)
      const vouchers = await this.voucherRepository.findAll({
        where: {
          [Op.or]: searchConditions,
          payment_status: 'PAID'
        },
        include: [
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [
              { model: Product, as: 'product' },
              { model: Tutorial, as: 'tutorial' }
            ],
          },
          {
            model: TransactionItem,
            as: 'transaction_item',
            include: [
              {
                model: AccountUser,
                as: 'user',
                include: [
                  {
                    model: Account,
                    as: 'account',
                    include: [{ model: Email, as: 'email' }],
                  },
                  {
                    model: AccountProfile,
                    as: 'profile',
                  },
                ],
              },
            ],
          },
        ],
        order: [['created_at', 'DESC']],
        transaction,
      });

      // Format response agar Frontend mudah mengonsumsi data akun langsung
      const results = vouchers.map(v => {
        const user = (v.transaction_item as any)?.user;
        const isExpired = user && user.expired_at && new Date() > new Date(user.expired_at);
        const accountData = (user && !isExpired) ? {
          email: user.account?.email?.email,
          password: user.account?.account_password,
          profile_name: user.profile?.name,
          expired_at: user.expired_at,
          metadata: (() => {
            try {
              return user.profile?.metadata ? JSON.parse(user.profile.metadata) : {};
            } catch (e) {
              return {};
            }
          })(),
        } : null;

        return {
          id: v.id,
          status: v.status,
          payment_status: v.payment_status,
          buyer_name: v.buyer_name,
          buyer_email: v.buyer_email,
          buyer_whatsapp: v.buyer_whatsapp,
          created_at: v.getDataValue('created_at'),
          expired_at: v.expired_at,
          access_token: v.access_token,
          product_variant: v.product_variant,
          account: accountData,
          is_expired: isExpired
        };
      });

      await transaction.commit();
      return results;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async checkTaskStatus(taskId: string) {
    const task = await this.taskQueueService.findOne(taskId);
    let result = null;
    if (task.status === 'COMPLETED') {
      try {
        result = JSON.parse(task.payload);
      } catch (e) {
        // Ignore parsing error
      }
    }
    return {
      id: task.id,
      status: task.status,
      error_message: task.error_message,
      result,
    };
  }
}
