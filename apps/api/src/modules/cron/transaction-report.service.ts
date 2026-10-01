import { Inject, Injectable } from '@nestjs/common';
import { TENANT_REPOSITORY } from 'src/constants/database.const';
import { Tenant } from 'src/database/models/tenant.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { AppLoggerService } from '../logger/logger.service';

@Injectable()
export class TransactionReportService {
  sqlPeriodicQuery = {
    createParamsTable: `CREATE TEMP TABLE _params ON COMMIT DROP AS WITH base AS ( SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date AS today_local ) SELECT b.today_local, (b.today_local + INTERVAL '1 day')::date AS tomorrow_local, (b.today_local::timestamp AT TIME ZONE 'Asia/Jakarta') AS today_start_utc, ((b.today_local + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Jakarta') AS tomorrow_start_utc FROM base b;`,
    dailyRevenue: `INSERT INTO revenue_statistics ("date", "type", total_revenue, transaction_count, created_at, updated_at) SELECT p.today_local AS "date", 'daily' AS "type", COALESCE(SUM(t.total_price), 0) AS total_revenue, COALESCE(COUNT(t.id), 0) AS transaction_count, NOW(), NOW() FROM _params p LEFT JOIN transaction t ON t.created_at >= p.today_start_utc AND t.created_at < p.tomorrow_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.today_local ON CONFLICT ("date", "type") DO UPDATE SET total_revenue = EXCLUDED.total_revenue, transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    dailyProductSales: `INSERT INTO product_sales_statistics ("date", "type", product_variant_id, items_sold, created_at, updated_at) SELECT p.today_local AS "date", 'daily' AS "type", pv.id AS product_variant_id, COUNT(ti.id) AS items_sold, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.today_start_utc AND t.created_at < p.tomorrow_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) JOIN transaction_item ti ON ti.transaction_id = t.id JOIN account_user au ON ti.account_user_id = au.id JOIN account a ON au.account_id = a.id JOIN product_variant pv ON a.product_variant_id = pv.id GROUP BY p.today_local, pv.id ON CONFLICT ("date", "type", product_variant_id) DO UPDATE SET items_sold = EXCLUDED.items_sold, updated_at = NOW();`,
    dailyPeakHour: `INSERT INTO peak_hour_statistics ("date", "type", "hour", transaction_count, created_at, updated_at) SELECT p.today_local AS "date", 'daily' AS "type", EXTRACT(HOUR FROM (t.created_at AT TIME ZONE 'Asia/Jakarta'))::SMALLINT AS "hour", COUNT(t.id) AS transaction_count, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.today_start_utc AND t.created_at < p.tomorrow_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.today_local, "hour" ON CONFLICT ("date", "type", "hour") DO UPDATE SET transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    dailyPlatform: `INSERT INTO platform_statistics ("date", "type", platform, transaction_count, created_at, updated_at) SELECT p.today_local AS "date", 'daily' AS "type", t.platform AS platform, COUNT(t.id) AS transaction_count, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.today_start_utc AND t.created_at < p.tomorrow_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.today_local, t.platform ON CONFLICT ("date", "type", platform) DO UPDATE SET transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
  };

  sqlDailyMonthlyQuery = {
    createParamsTable: `CREATE TEMP TABLE _params ON COMMIT DROP AS WITH base AS ( SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date AS today_local, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 day')::date AS yesterday_local ), month_bounds AS ( SELECT date_trunc('month', (b.yesterday_local::timestamp))::date AS target_month_start_local, b.today_local, b.yesterday_local FROM base b ) SELECT mb.today_local, mb.yesterday_local, mb.target_month_start_local, (mb.yesterday_local::timestamp AT TIME ZONE 'Asia/Jakarta') AS yesterday_start_utc, (mb.today_local::timestamp AT TIME ZONE 'Asia/Jakarta') AS today_start_utc, (mb.target_month_start_local::timestamp AT TIME ZONE 'Asia/Jakarta') AS month_start_utc FROM month_bounds mb;`,
    finalizeDailyRevenue: `INSERT INTO revenue_statistics ("date", "type", total_revenue, transaction_count, created_at, updated_at) SELECT p.yesterday_local AS "date", 'daily' AS "type", COALESCE(SUM(t.total_price), 0) AS total_revenue, COALESCE(COUNT(t.id), 0) AS transaction_count, NOW(), NOW() FROM _params p LEFT JOIN transaction t ON t.created_at >= p.yesterday_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.yesterday_local ON CONFLICT ("date", "type") DO UPDATE SET total_revenue = EXCLUDED.total_revenue, transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    monthlyRevenue: `INSERT INTO revenue_statistics ("date", "type", total_revenue, transaction_count, created_at, updated_at) SELECT p.target_month_start_local AS "date", 'monthly' AS "type", COALESCE(SUM(t.total_price), 0) AS total_revenue, COALESCE(COUNT(t.id), 0) AS transaction_count, NOW(), NOW() FROM _params p LEFT JOIN transaction t ON t.created_at >= p.month_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.target_month_start_local ON CONFLICT ("date", "type") DO UPDATE SET total_revenue = EXCLUDED.total_revenue, transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    finalizeDailyProductSales: `INSERT INTO product_sales_statistics ("date", "type", product_variant_id, items_sold, created_at, updated_at) SELECT p.yesterday_local AS "date", 'daily' AS "type", pv.id AS product_variant_id, COUNT(ti.id) AS items_sold, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.yesterday_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) JOIN transaction_item ti ON ti.transaction_id = t.id JOIN account_user au ON ti.account_user_id = au.id JOIN account a ON au.account_id = a.id JOIN product_variant pv ON a.product_variant_id = pv.id GROUP BY p.yesterday_local, pv.id ON CONFLICT ("date", "type", product_variant_id) DO UPDATE SET items_sold = EXCLUDED.items_sold, updated_at = NOW();`,
    monthlyProductSales: `INSERT INTO product_sales_statistics ("date", "type", product_variant_id, items_sold, created_at, updated_at) SELECT p.target_month_start_local AS "date", 'monthly' AS "type", pv.id AS product_variant_id, COUNT(ti.id) AS items_sold, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.month_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) JOIN transaction_item ti ON ti.transaction_id = t.id JOIN account_user au ON ti.account_user_id = au.id JOIN account a ON au.account_id = a.id JOIN product_variant pv ON a.product_variant_id = pv.id GROUP BY p.target_month_start_local, pv.id ON CONFLICT ("date", "type", product_variant_id) DO UPDATE SET items_sold = EXCLUDED.items_sold, updated_at = NOW();`,
    finalizeDailyPeakHour: `INSERT INTO peak_hour_statistics ("date", "type", "hour", transaction_count, created_at, updated_at) SELECT p.yesterday_local AS "date", 'daily' AS "type", EXTRACT(HOUR FROM (t.created_at AT TIME ZONE 'Asia/Jakarta'))::SMALLINT AS "hour", COUNT(t.id) AS transaction_count, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.yesterday_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.yesterday_local, "hour" ON CONFLICT ("date", "type", "hour") DO UPDATE SET transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    monthlyPeakHour: `INSERT INTO peak_hour_statistics ("date", "type", "hour", transaction_count, created_at, updated_at) SELECT p.target_month_start_local AS "date", 'monthly' AS "type", EXTRACT(HOUR FROM (t.created_at AT TIME ZONE 'Asia/Jakarta'))::SMALLINT AS "hour", COUNT(t.id) AS transaction_count, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.month_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.target_month_start_local, "hour" ON CONFLICT ("date", "type", "hour") DO UPDATE SET transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    finalizeDailyPlatform: `INSERT INTO platform_statistics ("date", "type", platform, transaction_count, created_at, updated_at) SELECT p.yesterday_local AS "date", 'daily' AS "type", t.platform AS platform, COUNT(t.id) AS transaction_count, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.yesterday_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.yesterday_local, t.platform ON CONFLICT ("date", "type", platform) DO UPDATE SET transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
    monthlyPlatform: `INSERT INTO platform_statistics ("date", "type", platform, transaction_count, created_at, updated_at) SELECT p.target_month_start_local AS "date", 'monthly' AS "type", t.platform AS platform, COUNT(t.id) AS transaction_count, NOW(), NOW() FROM _params p JOIN transaction t ON t.created_at >= p.month_start_utc AND t.created_at < p.today_start_utc AND NOT EXISTS (SELECT 1 FROM voucher v WHERE (v.transaction_id = t.id OR v.payment_id = t.id) AND (v.payment_status IS NULL OR v.payment_status != 'PAID')) GROUP BY p.target_month_start_local, t.platform ON CONFLICT ("date", "type", platform) DO UPDATE SET transaction_count = EXCLUDED.transaction_count, updated_at = NOW();`,
  };

  constructor(
    private readonly logger: AppLoggerService,
    private readonly postgresProvider: PostgresProvider,
    @Inject(TENANT_REPOSITORY) private readonly tenantRepository: typeof Tenant,
  ) {}

  private async getTenants() {
    let tenants: string[] = [];
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      const tenantDb = await this.tenantRepository.findAll({
        raw: true,
        transaction,
      });
      tenants = tenantDb.map(t => t.id);
      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      this.logger.error(
        (error as Error).message,
        (error as Error).stack,
        'TransactionReportGetTenant',
      );
    }
    return tenants;
  }

  async periodicReport() {
    this.logger.log('Running Hourly Aggregate Transaction Report', 'TransactionReport');
    const tenants = await this.getTenants();

    if (tenants.length) {
      for (const tenant of tenants) {
        const transaction = await this.postgresProvider.transaction();
        try {
          await this.postgresProvider.setSchema(tenant, transaction);

          await this.postgresProvider.rawQuery(
            this.sqlPeriodicQuery.createParamsTable,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlPeriodicQuery.dailyRevenue,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlPeriodicQuery.dailyProductSales,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlPeriodicQuery.dailyPeakHour,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlPeriodicQuery.dailyPlatform,
            {
              transaction,
            },
          );

          await transaction.commit();
        }
        catch (error) {
          await transaction.rollback();
          this.logger.error(
            (error as Error).message,
            (error as Error).stack,
            'TransactionReport',
          );
        }
      }
    }
  }

  async dailyReport() {
    this.logger.log('Running Daily Aggregate Transaction Report', 'TransactionReport');
    const tenants = await this.getTenants();

    if (tenants.length) {
      for (const tenant of tenants) {
        const transaction = await this.postgresProvider.transaction();
        try {
          await this.postgresProvider.setSchema(tenant, transaction);

          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.createParamsTable,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.finalizeDailyRevenue,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.monthlyRevenue,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.finalizeDailyProductSales,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.monthlyProductSales,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.finalizeDailyPeakHour,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.monthlyPeakHour,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.finalizeDailyPlatform,
            {
              transaction,
            },
          );
          await this.postgresProvider.rawQuery(
            this.sqlDailyMonthlyQuery.monthlyPlatform,
            {
              transaction,
            },
          );

          await transaction.commit();
        }
        catch (error) {
          await transaction.rollback();
          this.logger.error(
            (error as Error).message,
            (error as Error).stack,
            'TransactionReport',
          );
        }
      }
    }
  }
}
