import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { PostgresProvider } from 'src/database/postgres.provider';

export type StatisticFilterType
  = | 'realtime'
    | 'today'
    | 'yesterday'
    | 'last_7_days'
    | 'last_30_days'
    | 'custom_day'
    | 'custom_week'
    | 'custom_month'
    | 'custom_year';

export type ChartGranularity = 'hour' | 'day' | 'month';

export interface StatisticParams {
  filter?: StatisticFilterType;
  date?: string; // YYYY-MM-DD  — for custom_day
  start_date?: string; // YYYY-MM-DD  — for custom_week start
  end_date?: string; // YYYY-MM-DD  — for custom_week end
  year?: string; // YYYY        — for custom_year / custom_month
  month?: string; // MM (1-12)   — for custom_month
  product_variant_id?: string;
  platform?: string;
}

interface DateRange {
  start: Date;
  end: Date;
  prevStart: Date | null;
  prevEnd: Date | null;
  granularity: ChartGranularity;
}

@Injectable()
export class StatisticService {
  constructor(private readonly postgresProvider: PostgresProvider) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Date-range resolver (WIB/UTC+7)
  // ──────────────────────────────────────────────────────────────────────────
  private readonly WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

  private toWIBDate(date: Date): Date {
    return new Date(date.getTime() + this.WIB_OFFSET_MS);
  }

  private fromWIBToUTC(date: Date): Date {
    return new Date(date.getTime() - this.WIB_OFFSET_MS);
  }

  private resolveDateRange(params: StatisticParams): DateRange {
    const now = new Date();
    const nowWIB = this.toWIBDate(now);

    const todayStartWIB = new Date(Date.UTC(
      nowWIB.getUTCFullYear(),
      nowWIB.getUTCMonth(),
      nowWIB.getUTCDate(),
    ));

    const filter: StatisticFilterType = params.filter ?? 'today';

    let startWIB: Date; let endWIB: Date; let prevStartWIB: Date | null = null; let prevEndWIB: Date | null = null;
    let granularity: ChartGranularity = 'hour';

    switch (filter) {
      case 'realtime':
      case 'today': {
        startWIB = new Date(todayStartWIB);
        endWIB = nowWIB;

        prevStartWIB = new Date(todayStartWIB);
        prevStartWIB.setUTCDate(prevStartWIB.getUTCDate() - 1);
        prevEndWIB = new Date(nowWIB);
        prevEndWIB.setUTCDate(prevEndWIB.getUTCDate() - 1);
        granularity = 'hour';
        break;
      }
      case 'yesterday': {
        startWIB = new Date(todayStartWIB);
        startWIB.setUTCDate(startWIB.getUTCDate() - 1);
        endWIB = new Date(todayStartWIB);
        endWIB.setUTCMilliseconds(-1);

        prevStartWIB = new Date(startWIB);
        prevStartWIB.setUTCDate(prevStartWIB.getUTCDate() - 1);
        prevEndWIB = new Date(startWIB);
        prevEndWIB.setUTCMilliseconds(-1);
        granularity = 'hour';
        break;
      }
      case 'last_7_days': {
        startWIB = new Date(todayStartWIB);
        startWIB.setUTCDate(startWIB.getUTCDate() - 7);
        endWIB = nowWIB;

        prevStartWIB = new Date(startWIB);
        prevStartWIB.setUTCDate(prevStartWIB.getUTCDate() - 7);
        prevEndWIB = new Date(startWIB);
        prevEndWIB.setUTCMilliseconds(-1);
        granularity = 'day';
        break;
      }
      case 'last_30_days': {
        startWIB = new Date(todayStartWIB);
        startWIB.setUTCDate(startWIB.getUTCDate() - 30);
        endWIB = nowWIB;

        prevStartWIB = new Date(startWIB);
        prevStartWIB.setUTCDate(prevStartWIB.getUTCDate() - 30);
        prevEndWIB = new Date(startWIB);
        prevEndWIB.setUTCMilliseconds(-1);
        granularity = 'day';
        break;
      }
      case 'custom_day': {
        if (params.date) {
          const [y, m, d] = params.date.split('-');
          startWIB = new Date(Date.UTC(Number.parseInt(y), Number.parseInt(m) - 1, Number.parseInt(d)));
        }
        else {
          startWIB = new Date(todayStartWIB);
        }
        endWIB = new Date(startWIB);
        endWIB.setUTCDate(endWIB.getUTCDate() + 1);
        endWIB.setUTCMilliseconds(-1);

        prevStartWIB = new Date(startWIB);
        prevStartWIB.setUTCDate(prevStartWIB.getUTCDate() - 1);
        prevEndWIB = new Date(startWIB);
        prevEndWIB.setUTCMilliseconds(-1);
        granularity = 'hour';
        break;
      }
      case 'custom_week': {
        startWIB = params.start_date ? new Date(`${params.start_date}T00:00:00.000Z`) : new Date(todayStartWIB);
        endWIB = params.end_date ? new Date(`${params.end_date}T23:59:59.999Z`) : new Date(nowWIB);

        const diffDays = Math.round((endWIB.getTime() - startWIB.getTime()) / (1000 * 60 * 60 * 24));
        prevStartWIB = new Date(startWIB);
        prevStartWIB.setUTCDate(prevStartWIB.getUTCDate() - diffDays);
        prevEndWIB = new Date(startWIB);
        prevEndWIB.setUTCMilliseconds(-1);
        granularity = 'day';
        break;
      }
      case 'custom_month': {
        const yr = params.year ? Number.parseInt(params.year, 10) : nowWIB.getUTCFullYear();
        const mo = params.month ? Number.parseInt(params.month, 10) - 1 : nowWIB.getUTCMonth();
        startWIB = new Date(Date.UTC(yr, mo, 1));
        endWIB = new Date(Date.UTC(yr, mo + 1, 0, 23, 59, 59, 999));

        prevStartWIB = new Date(Date.UTC(yr, mo - 1, 1));

        if (yr === nowWIB.getUTCFullYear() && mo === nowWIB.getUTCMonth()) {
          // If filtering current month, limit prevEndWIB to the same date/time in the previous month
          const prevMonthMaxDays = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
          const targetDay = Math.min(nowWIB.getUTCDate(), prevMonthMaxDays);
          prevEndWIB = new Date(Date.UTC(yr, mo - 1, targetDay, nowWIB.getUTCHours(), nowWIB.getUTCMinutes(), nowWIB.getUTCSeconds(), nowWIB.getUTCMilliseconds()));
        }
        else {
          prevEndWIB = new Date(Date.UTC(yr, mo, 0, 23, 59, 59, 999));
        }

        granularity = 'day';
        break;
      }
      case 'custom_year': {
        const yr = params.year ? Number.parseInt(params.year, 10) : nowWIB.getUTCFullYear();
        startWIB = new Date(Date.UTC(yr, 0, 1));
        endWIB = new Date(Date.UTC(yr, 11, 31, 23, 59, 59, 999));

        prevStartWIB = new Date(Date.UTC(yr - 1, 0, 1));

        if (yr === nowWIB.getUTCFullYear()) {
          // If filtering current year, limit prevEndWIB to the same date/time in the previous year
          const isLeapYear = (y: number) => new Date(y, 1, 29).getMonth() === 1;
          const targetMo = nowWIB.getUTCMonth();
          let targetDay = nowWIB.getUTCDate();
          if (targetMo === 1 && targetDay === 29 && !isLeapYear(yr - 1)) {
            targetDay = 28;
          }
          prevEndWIB = new Date(Date.UTC(yr - 1, targetMo, targetDay, nowWIB.getUTCHours(), nowWIB.getUTCMinutes(), nowWIB.getUTCSeconds(), nowWIB.getUTCMilliseconds()));
        }
        else {
          prevEndWIB = new Date(Date.UTC(yr - 1, 11, 31, 23, 59, 59, 999));
        }

        granularity = 'month';
        break;
      }
      default:
        startWIB = new Date(todayStartWIB);
        endWIB = nowWIB;
        granularity = 'hour';
    }

    return {
      start: this.fromWIBToUTC(startWIB),
      end: this.fromWIBToUTC(endWIB),
      prevStart: prevStartWIB ? this.fromWIBToUTC(prevStartWIB) : null,
      prevEnd: prevEndWIB ? this.fromWIBToUTC(prevEndWIB) : null,
      granularity,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Main entry-point
  // ──────────────────────────────────────────────────────────────────────────
  async getStatistic(tenantId: string, params: StatisticParams) {
    const tx = await this.postgresProvider.transaction();

    try {
      await this.postgresProvider.setSchema(tenantId, tx);
      const { start, end, prevStart, prevEnd, granularity } = this.resolveDateRange(params);

      // Build dynamic filters
      // Exclude transactions associated with unpaid / pending vouchers
      let trxWhere = ` AND NOT EXISTS (
        SELECT 1 FROM "voucher" v
        WHERE (v.transaction_id = t.id OR v.payment_id = t.id)
          AND (v.payment_status IS NULL OR v.payment_status != 'PAID')
      )`;
      if (params.platform) {
        trxWhere += ` AND t.platform ILIKE :platform`;
      }
      if (params.product_variant_id) {
        trxWhere += ` AND (
          t.id IN (
            SELECT ti.transaction_id
            FROM "transaction_item" ti
            JOIN "account_user" au ON au.id = ti.account_user_id
            JOIN "account" acc ON acc.id = au.account_id
            WHERE acc.product_variant_id = :product_variant_id
          )
          OR t.id IN (
            SELECT v.transaction_id
            FROM "voucher" v
            WHERE v.product_variant_id = :product_variant_id
          )
        )`;
      }

      // Build capital dynamic query
      let capitalQuery = '';
      if (params.product_variant_id) {
        capitalQuery = `
          (SELECT COALESCE(SUM(capital_price), 0) FROM "account" WHERE product_variant_id = :product_variant_id AND created_at >= :start AND created_at <= :end) +
          (SELECT COALESCE(SUM(ac.amount), 0) FROM "account_capital" ac JOIN "account" acc ON acc.id = ac.account_id WHERE acc.product_variant_id = :product_variant_id AND ac.created_at >= :start AND ac.created_at <= :end)
        `;
      }
      else {
        capitalQuery = `
          (SELECT COALESCE(SUM(capital_price), 0) FROM "account" WHERE created_at >= :start AND created_at <= :end) +
          (SELECT COALESCE(SUM(amount), 0) FROM "account_capital" WHERE created_at >= :start AND created_at <= :end)
        `;
      }

      const repl = {
        start: start.toISOString(),
        end: end.toISOString(),
        granularity,
        product_variant_id: params.product_variant_id ?? null,
        platform: params.platform ?? null,
      };

      // ── Summary card ────────────────────────────────────────────
      const summaryRaw = await this.postgresProvider.rawQuery(
        `SELECT
           COALESCE(rev.total_revenue, 0) AS total_revenue,
           COALESCE(cap.total_capital_price, 0) AS total_capital_price,
           (COALESCE(rev.total_revenue, 0) - COALESCE(cap.total_capital_price, 0)) AS gross_profit,
           COALESCE(rev.transaction_count, 0) AS transaction_count
         FROM
           (SELECT SUM(t.total_price) AS total_revenue, COUNT(t.id) AS transaction_count 
            FROM "transaction" t
            WHERE t.created_at >= :start AND t.created_at <= :end${trxWhere}) rev,
           (SELECT ${capitalQuery} AS total_capital_price) cap`,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      const summary = summaryRaw[0] ?? {};

      // ── Previous Summary card for % comparison ──────────────────
      let prevSummary: any = {};
      if (prevStart && prevEnd) {
        const prevRepl = {
          start: prevStart.toISOString(),
          end: prevEnd.toISOString(),
          product_variant_id: params.product_variant_id ?? null,
          platform: params.platform ?? null,
        };
        const prevSummaryRaw = await this.postgresProvider.rawQuery(
          `SELECT
             COALESCE(rev.total_revenue, 0) AS total_revenue,
             COALESCE(cap.total_capital_price, 0) AS total_capital_price,
             (COALESCE(rev.total_revenue, 0) - COALESCE(cap.total_capital_price, 0)) AS gross_profit,
             COALESCE(rev.transaction_count, 0) AS transaction_count
           FROM
             (SELECT SUM(t.total_price) AS total_revenue, COUNT(t.id) AS transaction_count 
              FROM "transaction" t
              WHERE t.created_at >= :start AND t.created_at <= :end${trxWhere}) rev,
             (SELECT ${capitalQuery} AS total_capital_price) cap`,
          { type: QueryTypes.SELECT, transaction: tx, replacements: prevRepl },
        ) as any[];
        prevSummary = prevSummaryRaw[0] ?? {};
      }

      // ── Revenue chart (bucketed by granularity) ─────────────────
      const revenueChart = await this.postgresProvider.rawQuery(
        `SELECT
           date_trunc(:granularity, t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta') AS bucket,
           COALESCE(SUM(t.total_price), 0)        AS total_revenue,
           COUNT(DISTINCT t.id)                   AS transaction_count
         FROM "transaction" t
         WHERE t.created_at >= :start
           AND t.created_at <= :end${trxWhere}
         GROUP BY bucket
         ORDER BY bucket ASC`,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      // ── Peak-hour distribution ───────────────────────────────────
      const peakHour = await this.postgresProvider.rawQuery(
        `SELECT
           EXTRACT(hour FROM t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta')::INTEGER AS hour,
           COUNT(DISTINCT t.id)                     AS transaction_count
         FROM "transaction" t
         WHERE t.created_at >= :start
           AND t.created_at <= :end${trxWhere}
         GROUP BY hour
         ORDER BY hour ASC`,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      // ── Platform breakdown ───────────────────────────────────────
      const platform = await this.postgresProvider.rawQuery(
        `SELECT
           t.platform,
           COUNT(DISTINCT t.id)::INTEGER AS transaction_count,
           COALESCE(SUM(t.total_price), 0) AS total_revenue
         FROM "transaction" t
         WHERE t.created_at >= :start
           AND t.created_at <= :end${trxWhere}
         GROUP BY t.platform
         ORDER BY transaction_count DESC`,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      // ── Top products ─────────────────────────────────────────────
      const products = await this.postgresProvider.rawQuery(
        `SELECT
           pv.id          AS product_variant_id,
           p.name         AS product_name,
           pv.name        AS variant_name,
           COUNT(ti.id)::INTEGER AS items_sold
         FROM "transaction_item" ti
         JOIN "transaction"    t   ON t.id   = ti.transaction_id
         JOIN "account_user"   au  ON au.id  = ti.account_user_id
         JOIN "account"        acc ON acc.id = au.account_id
         JOIN "product_variant" pv ON pv.id  = acc.product_variant_id
         JOIN "product"         p  ON p.id   = pv.product_id
         WHERE t.created_at >= :start
           AND t.created_at <= :end${trxWhere}
         GROUP BY pv.id, p.name, pv.name
         ORDER BY items_sold DESC
         LIMIT 10`,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      // ── Capital Details ──────────────────────────────────────────
      let capitalDetailsQuery = '';
      if (params.product_variant_id) {
        capitalDetailsQuery = `
          SELECT 
            e.email,
            CONCAT(p.name, ' - ', pv.name) AS variant_name,
            acc.created_at AS date,
            acc.capital_price AS nominal,
            'Account Creation' AS type
          FROM "account" acc
          JOIN "email" e ON e.id = acc.email_id
          JOIN "product_variant" pv ON pv.id = acc.product_variant_id
          JOIN "product" p ON p.id = pv.product_id
          WHERE acc.product_variant_id = :product_variant_id 
            AND acc.created_at >= :start AND acc.created_at <= :end
            AND acc.capital_price > 0
          
          UNION ALL
          
          SELECT 
            e.email,
            CONCAT(p.name, ' - ', pv.name) AS variant_name,
            ac.created_at AS date,
            ac.amount AS nominal,
            'Additional Capital' AS type
          FROM "account_capital" ac
          JOIN "account" acc ON acc.id = ac.account_id
          JOIN "email" e ON e.id = acc.email_id
          JOIN "product_variant" pv ON pv.id = acc.product_variant_id
          JOIN "product" p ON p.id = pv.product_id
          WHERE acc.product_variant_id = :product_variant_id 
            AND ac.created_at >= :start AND ac.created_at <= :end
            AND ac.amount > 0
          
          ORDER BY date DESC
        `;
      }
      else {
        capitalDetailsQuery = `
          SELECT 
            e.email,
            CONCAT(p.name, ' - ', pv.name) AS variant_name,
            acc.created_at AS date,
            acc.capital_price AS nominal,
            'Account Creation' AS type
          FROM "account" acc
          JOIN "email" e ON e.id = acc.email_id
          JOIN "product_variant" pv ON pv.id = acc.product_variant_id
          JOIN "product" p ON p.id = pv.product_id
          WHERE acc.created_at >= :start AND acc.created_at <= :end
            AND acc.capital_price > 0
          
          UNION ALL
          
          SELECT 
            e.email,
            CONCAT(p.name, ' - ', pv.name) AS variant_name,
            ac.created_at AS date,
            ac.amount AS nominal,
            'Additional Capital' AS type
          FROM "account_capital" ac
          JOIN "account" acc ON acc.id = ac.account_id
          JOIN "email" e ON e.id = acc.email_id
          JOIN "product_variant" pv ON pv.id = acc.product_variant_id
          JOIN "product" p ON p.id = pv.product_id
          WHERE ac.created_at >= :start AND ac.created_at <= :end
            AND ac.amount > 0
            
          ORDER BY date DESC
        `;
      }

      const capitalDetails = await this.postgresProvider.rawQuery(
        capitalDetailsQuery,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      // ── Revenue Details ──────────────────────────────────────────
      const revenueDetailsQuery = `
        SELECT 
          t.id,
          t.created_at AS date,
          COALESCE(MAX(e.email), MAX(v.buyer_email), '-') AS email,
          COALESCE(MAX(CONCAT(p.name, ' - ', pv.name)), MAX(CONCAT(vp.name, ' - ', vpv.name)), MAX(ti.name), '-') AS variant_name,
          t.customer,
          t.platform,
          t.total_price AS nominal
        FROM "transaction" t
        LEFT JOIN "transaction_item" ti ON ti.transaction_id = t.id
        LEFT JOIN "account_user" au ON au.id = ti.account_user_id
        LEFT JOIN "account" acc ON acc.id = au.account_id
        LEFT JOIN "email" e ON e.id = acc.email_id
        LEFT JOIN "product_variant" pv ON pv.id = acc.product_variant_id
        LEFT JOIN "product" p ON p.id = pv.product_id
        LEFT JOIN "voucher" v ON (v.transaction_id = t.id OR v.payment_id = t.id)
        LEFT JOIN "product_variant" vpv ON vpv.id = v.product_variant_id
        LEFT JOIN "product" vp ON vp.id = vpv.product_id
        WHERE t.created_at >= :start AND t.created_at <= :end ${trxWhere}
        GROUP BY t.id, t.created_at, t.customer, t.platform, t.total_price
        ORDER BY t.created_at DESC
      `;

      const revenueDetails = await this.postgresProvider.rawQuery(
        revenueDetailsQuery,
        { type: QueryTypes.SELECT, transaction: tx, replacements: repl },
      ) as any[];

      await tx.commit();

      // ── Format label for X-axis based on granularity ─────────────
      const fmtBucket = (raw: string) => {
        const d = new Date(raw);
        // raw is already truncated in WIB using AT TIME ZONE 'Asia/Jakarta'
        // Which means Postgres returns the timestamp without timezone at the WIB local time.
        // E.g., '2026-05-22 00:00:00'. When passed to new Date(raw), JS interprets it in UTC since we use `toISOString` later, or local.
        // It's safest to treat `d` as UTC because of Postgres driver behavior with "timestamp without time zone".
        if (granularity === 'hour')
          return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
        if (granularity === 'month')
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        // day: YYYY-MM-DD
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      };

      const calcPercentage = (current: number, prev: number) => {
        if (prev === 0 && current === 0)
          return 0;
        if (prev === 0)
          return 100;
        return ((current - prev) / Math.abs(prev)) * 100;
      };

      const curRevenue = Number(summary.total_revenue ?? 0);
      const prevRevenue = Number(prevSummary.total_revenue ?? 0);
      const curProfit = Number(summary.gross_profit ?? 0);
      const prevProfit = Number(prevSummary.gross_profit ?? 0);
      const curTrx = Number(summary.transaction_count ?? 0);
      const prevTrx = Number(prevSummary.transaction_count ?? 0);

      return {
        summary: {
          total_revenue: curRevenue,
          revenue_percentage: calcPercentage(curRevenue, prevRevenue),
          total_capital_price: Number(summary.total_capital_price ?? 0),
          gross_profit: curProfit,
          profit_percentage: calcPercentage(curProfit, prevProfit),
          transaction_count: curTrx,
          transaction_percentage: calcPercentage(curTrx, prevTrx),
        },
        charts: {
          revenue: revenueChart.map(r => ({
            bucket: fmtBucket(r.bucket),
            total_revenue: Number(r.total_revenue),
            transaction_count: Number(r.transaction_count),
          })),
          peakHour: peakHour.map(p => ({
            hour: Number(p.hour),
            transaction_count: Number(p.transaction_count),
          })),
          platform: platform.map(p => ({
            platform: p.platform as string,
            transaction_count: Number(p.transaction_count),
            total_revenue: Number(p.total_revenue),
          })),
          products: products.map(p => ({
            product_variant_id: String(p.product_variant_id),
            product_name: p.product_name as string,
            variant_name: p.variant_name as string,
            items_sold: Number(p.items_sold),
          })),
          capital_details: capitalDetails.map(c => ({
            email: c.email as string,
            variant_name: c.variant_name as string,
            date: new Date(c.date).toISOString(),
            nominal: Number(c.nominal),
            type: c.type as string,
          })),
          revenue_details: revenueDetails.map(r => ({
            id: r.id as string,
            date: new Date(r.date).toISOString(),
            email: r.email as string,
            variant_name: r.variant_name as string,
            customer: r.customer as string,
            platform: r.platform as string,
            nominal: Number(r.nominal),
          })),
        },
        meta: {
          filter: params.filter ?? 'today',
          granularity,
          start: start.toISOString(),
          end: end.toISOString(),
        },
      };
    }
    catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
