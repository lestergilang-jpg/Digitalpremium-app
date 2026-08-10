import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Op, QueryTypes } from 'sequelize';
import {
  PRODUCT_VARIANT_REPOSITORY,
  TENANT_REPOSITORY,
  TENANT_SETTING_REPOSITORY,
  TRANSACTION_ITEM_REPOSITORY,
  TRANSACTION_REPOSITORY,
  VOUCHER_REPOSITORY,
  SHOP_REPOSITORY,
} from 'src/constants/database.const';
import { Shop } from 'src/database/models/shop.model';
import { TenantSetting } from 'src/database/models/tenant-setting.model';
import { AccountProfile } from 'src/database/models/account-profile.model';
import { AccountUser } from 'src/database/models/account-user.model';
import { Account } from 'src/database/models/account.model';
import { Email } from 'src/database/models/email.model';
import { ProductVariant } from 'src/database/models/product-variant.model';
import { Product } from 'src/database/models/product.model';
import { Tenant } from 'src/database/models/tenant.model';
import { TransactionItem } from 'src/database/models/transaction-item.model';
import { Transaction } from 'src/database/models/transaction.model';
import { Voucher } from 'src/database/models/voucher.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class VoucherService {
  private readonly logger = new Logger(VoucherService.name);

  constructor(
    private readonly postgresProvider: PostgresProvider,
    private readonly configService: ConfigService,
    @Inject(PRODUCT_VARIANT_REPOSITORY)
    private readonly productVariantRepository: typeof ProductVariant,
    @Inject(TRANSACTION_REPOSITORY)
    private readonly transactionRepository: typeof Transaction,
    @Inject(TRANSACTION_ITEM_REPOSITORY)
    private readonly transactionItemRepository: typeof TransactionItem,
    @Inject(VOUCHER_REPOSITORY)
    private readonly voucherRepository: typeof Voucher,
    @Inject(TENANT_REPOSITORY)
    private readonly tenantRepository: typeof Tenant,
    @Inject(TENANT_SETTING_REPOSITORY)
    private readonly tenantSettingRepository: typeof TenantSetting,
    @Inject(SHOP_REPOSITORY)
    private readonly shopRepository: typeof Shop,
    private readonly whatsappService: WhatsappService,
  ) {}

  private generateVoucherCode(prefix: string = 'MNL-'): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = prefix;
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  async generateManualVoucher(tenantId: string, dto: any) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const variant = await this.productVariantRepository.findOne({
        where: { id: dto.product_variant_id },
        include: [{ model: Product, as: 'product' }],
        attributes: ['id', 'name', 'price', 'voucher_expiry_hours', 'duration'],
        transaction,
      });
      if (!variant)
        throw new NotFoundException('Varian produk tidak ditemukan');

      const voucherCode = this.generateVoucherCode(dto.prefix || 'MNL-');
      const expiryHours = variant.voucher_expiry_hours ?? this.configService.get<number>('voucher.expiryHours') ?? 168; // fallback to config or 7 days
      const expiredAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

      const orderId = `M-${tenantId.toUpperCase().substring(0, 3)}-${Date.now()}`;

      const platform = dto.platform || 'dashboard';
      let mdr_fee = 0;
      let platform_fee = 0;
      const total_price = dto.price ? Number(dto.price) : Number(variant.price || 0);

      if (platform.toUpperCase() === 'LANDING_PAGE') {
        const settings = await this.tenantSettingRepository.findAll({
          where: { key: ['doku_mdr', 'platform_fee'] },
          transaction,
        });
        
        mdr_fee = 4500;
        platform_fee = 500;

        for (const setting of settings) {
          if (setting.key === 'doku_mdr' && !isNaN(Number(setting.value))) {
            mdr_fee = Number(setting.value);
          }
          if (setting.key === 'platform_fee' && !isNaN(Number(setting.value))) {
            platform_fee = Number(setting.value);
          }
        }
      }

      const net_profit = total_price - mdr_fee - platform_fee;

      let shop_id: string | undefined = undefined;
      if (dto.store_name) {
        const shop = await this.shopRepository.findOne({
          where: { name: dto.store_name },
          transaction,
        });
        if (shop) {
          shop_id = String(shop.id);
        }
      }

      // 1. Create transaction
      const txn = await this.transactionRepository.create(
        {
          id: orderId,
          customer: dto.buyer_name,
          platform,
          total_price,
          mdr_fee,
          platform_fee,
          net_profit,
          shop_id,
        },
        { transaction },
      );

      // 2. Create transaction item
      const txnItem = await this.transactionItemRepository.create(
        {
          name: `${(variant as any).product?.name ?? 'Produk'} - ${variant.name} (Manual)`,
          transaction_id: txn.id,
        },
        { transaction },
      );

      // 3. Create voucher
      const voucher = await this.voucherRepository.create(
        {
          id: voucherCode,
          product_variant_id: dto.product_variant_id,
          buyer_name: dto.buyer_name,
          buyer_email: dto.buyer_email,
          buyer_whatsapp: dto.buyer_whatsapp,
          expired_at: expiredAt,
          transaction_id: txn.id,
          transaction_item_id: txnItem.id,
          payment_id: orderId,
          status: 'UNUSED',
          payment_status: 'PAID', // Directly PAID because manual
        },
        { transaction },
      );



      await transaction.commit();

      // Kirim kode voucher via WhatsApp (non-blocking — tidak gagalkan transaksi)
      if (voucher.buyer_whatsapp) {
        const productFullName = `${(variant as any).product?.name ?? 'Produk'} - ${variant.name}`;
        this.whatsappService
          .sendVoucherCode({
            buyerPhone: voucher.buyer_whatsapp,
            buyerName: voucher.buyer_name,
            voucherCode: String(voucher.id),
            productName: productFullName,
            expiredAt: voucher.expired_at,
            tenantId: tenantId,
          })
          .catch(err =>
            this.logger.error(`[WA] Gagal kirim voucher ${voucher.id} (non-fatal):`, err),
          );
      }

      return voucher;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getVouchers(tenantId: string, options: { limit?: number; offset?: number; search?: string; status?: string } = {}) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const { limit = 10, offset = 0, search, status } = options;
      const where: any = {};

      if (status && status !== 'ALL') {
        where.status = status;
      }

      if (search) {
        where[Op.or] = [
          { id: { [Op.iLike]: `%${search}%` } },
          { buyer_name: { [Op.iLike]: `%${search}%` } },
          { buyer_whatsapp: { [Op.iLike]: `%${search}%` } },
          { buyer_email: { [Op.iLike]: `%${search}%` } },
        ];
      }

      const { rows: items, count: total } = await this.voucherRepository.findAndCountAll({
        where,
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
        order: [['created_at', 'DESC']],
        limit,
        offset,
        transaction,
      });

      const formattedItems = items.map(v => {
        const user = (v.transaction_item as any)?.user;
        const isExpired = user && user.expired_at && new Date() > new Date(user.expired_at);
        
        const plainVoucher = v.toJSON() as any;
        if (plainVoucher.status === 'USED' && isExpired) {
          plainVoucher.status = 'CLAIMED EXPIRED';
        }
        return plainVoucher;
      });

      await transaction.commit();
      return { items: formattedItems, total };
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getStatistics(tenantId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const [stats]: any = await this.postgresProvider.rawQuery(`
        SELECT 
          COUNT(*)::INT as "totalGenerated",
          COUNT(*) FILTER (WHERE status = 'USED')::INT as "totalRedeemed",
          COUNT(*) FILTER (WHERE status = 'UNUSED' AND payment_status = 'PAID' AND expired_at > NOW())::INT as "totalTersedia",
          COUNT(*) FILTER (WHERE status = 'UNUSED')::INT as "totalUnused",
          COUNT(*) FILTER (WHERE status = 'PENDING')::INT as "totalPending",
          COUNT(*) FILTER (WHERE status = 'UNUSED' AND expired_at <= NOW())::INT as "totalKadaluarsa"
        FROM "voucher"
      `, {
        transaction,
        type: QueryTypes.SELECT,
      });

      // Untuk totalAktif (USED aktif + UNUSED belum expired)
      const [aktifResult]: any = await this.postgresProvider.rawQuery(`
        SELECT COUNT(*)::INT as "count"
        FROM "voucher" v
        LEFT JOIN "transaction_item" ti ON v.transaction_item_id = ti.id
        LEFT JOIN "account_user" au ON ti.account_user_id = au.id
        WHERE 
          (v.status = 'USED' AND (au.expired_at > NOW() OR au.expired_at IS NULL))
          OR 
          (v.status = 'UNUSED' AND v.expired_at > NOW())
      `, {
        transaction,
        type: QueryTypes.SELECT,
      });

      await transaction.commit();

      const result = {
        totalGenerated: stats.totalGenerated || 0,
        totalRedeemed: stats.totalRedeemed || 0,
        totalTersedia: stats.totalTersedia || 0,
        totalRedeemedDanTersedia: (stats.totalRedeemed || 0) + (stats.totalTersedia || 0),
        totalUnused: stats.totalUnused || 0,
        totalPending: stats.totalPending || 0,
        totalUsed: stats.totalRedeemed || 0,
        totalAktif: aktifResult.count || 0,
        totalKadaluarsa: stats.totalKadaluarsa || 0,
      };

      console.log(`[VoucherStats] ${tenantId} result:`, result);
      return result;
    }
    catch (error) {
      await transaction.rollback();
      console.error(`[VoucherStats] Error for ${tenantId}:`, error);
      throw error;
    }
  }

  async autoExpireVouchers() {
    const masterTransaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', masterTransaction);
      const tenants = await this.tenantRepository.findAll({
        raw: true,
        transaction: masterTransaction,
      });
      await masterTransaction.commit();

      for (const tenant of tenants) {
        const transaction = await this.postgresProvider.transaction();
        try {
          await this.postgresProvider.setSchema(tenant.id, transaction);

          const [updatedCount] = await this.voucherRepository.update(
            { status: 'EXPIRED' },
            {
              where: {
                status: { [Op.in]: ['UNUSED', 'PENDING'] },
                expired_at: { [Op.lte]: new Date() },
              },
              transaction,
            },
          );

          if (updatedCount > 0) {
            console.log(`[VoucherCron] Expired ${updatedCount} vouchers for tenant ${tenant.id}`);
          }

          await transaction.commit();
        }
        catch (error) {
          await transaction.rollback();
          console.error(`[VoucherCron] Error expiring vouchers for tenant ${tenant.id}:`, error.message);
        }
      }
    }
    catch (error) {
      await masterTransaction.rollback();
      console.error(`[VoucherCron] Error fetching tenants:`, error.message);
    }
  }
}
