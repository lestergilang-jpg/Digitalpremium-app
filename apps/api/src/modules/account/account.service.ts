import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Op, Order, QueryTypes, WhereOptions, Sequelize } from 'sequelize';
import {
  ACCOUNT_REPOSITORY,
  ACCOUNT_PROFILE_REPOSITORY,
  ACCOUNT_USER_REPOSITORY,
  ACCOUNT_CAPITAL_REPOSITORY,
  PRODUCT_VARIANT_REPOSITORY,
  EMAIL_REPOSITORY,
  ACCOUNT_LABEL_REPOSITORY,
  ACCOUNT_USER_MOVE_HISTORY_REPOSITORY,
  SHORT_URL_REPOSITORY,
  ACCOUNT_SESSION_REPOSITORY,
} from 'src/constants/database.const';
import * as crypto from 'node:crypto';
import { AccountSession } from 'src/database/models/account-session.model';
import {
  NETFLIX_RESET_PASSWORD,
  NETFLIX_AUTO_RELOAD,
  NETFLIX_AUTO_UPGRADE,
  NETFLIX_LOGIN_TV,
  UNFREEZE_ACCOUNT,
  SUBS_END_NOTIFY,
} from 'src/constants/task.const';
import { AccountProfile } from 'src/database/models/account-profile.model';
import { AccountUser } from 'src/database/models/account-user.model';
import {
  Account,
  AccountCreationAttributes,
} from 'src/database/models/account.model';
import { AccountCapital } from 'src/database/models/account-capital.model';
import { Email } from 'src/database/models/email.model';
import { ProductVariant } from 'src/database/models/product-variant.model';
import { Product } from 'src/database/models/product.model';
import { Label } from 'src/database/models/label.model';
import { AccountLabel } from 'src/database/models/account-label.model';
import { AccountUserMoveHistory } from 'src/database/models/account-user-move-history.model';
import { ShortUrl } from 'src/database/models/short-url.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { UpsertTaskQueueDto } from '../task-queue/dto/upsert-task-queue.dto';
import { TaskQueueService } from '../task-queue/task-queue.service';
import { AccountSubsEndNotifyPayload, NetflixAutoReloadPayload, NetflixResetPasswordPayload } from '../task-queue/types/task-context.type';
import { DateConverterProvider } from '../utility/date-converter.provider';
import { PaginationProvider } from '../utility/pagination.provider';
import { BaseGetAllUrlQuery } from '../utility/types/base-get-all-url-query.type';
import { CreateAccountDto } from './dto/create-account.dto';
import { BulkCreateAccountDto } from './dto/bulk-create-account.dto';
import { FreezeAccountDto } from './dto/freeze-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { IAccountGetFilter } from './filter/account-get.filter';
import { NetflixResetPasswordMetadata } from './types/netflix-reset-password-metadata.type';
import { SubsEndNotifyMetadata } from './types/subs-end-notify-metadata.type';
import { AppLoggerService } from '../logger/logger.service';
import { SocketGateway } from '../socket/socket.gateway';

@Injectable()
export class AccountService {
  // In-memory store for pending topup requests (auto-cleared after 15 min)
  private pendingTopupStore: Map<string, { accountId: string; email: string; billing: string; taskId: string; tenantId: string; createdAt: Date }> = new Map();

  constructor(
    private readonly paginationProvider: PaginationProvider,
    private readonly dateConverterProvider: DateConverterProvider,
    private readonly postgresProvider: PostgresProvider,
    private readonly taskQueueService: TaskQueueService,
    private readonly socketGateway: SocketGateway,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accountRepository: typeof Account,
    @Inject(ACCOUNT_PROFILE_REPOSITORY)
    private readonly accountProfileRepository: typeof AccountProfile,
    @Inject(ACCOUNT_USER_REPOSITORY)
    private readonly accountUserRepository: typeof AccountUser,
    @Inject(ACCOUNT_CAPITAL_REPOSITORY)
    private readonly accountCapitalRepository: typeof AccountCapital,
    @Inject(PRODUCT_VARIANT_REPOSITORY)
    private readonly productVariantRepository: typeof ProductVariant,
    @Inject(EMAIL_REPOSITORY)
    private readonly emailRepository: typeof Email,
    @Inject(ACCOUNT_LABEL_REPOSITORY)
    private readonly accountLabelRepository: typeof AccountLabel,
    @Inject(ACCOUNT_USER_MOVE_HISTORY_REPOSITORY)
    private readonly accountUserMoveHistoryRepository: typeof AccountUserMoveHistory,
    private readonly logger: AppLoggerService,
    @Inject(SHORT_URL_REPOSITORY)
    private readonly shortUrlRepository: typeof ShortUrl,
    @Inject(ACCOUNT_SESSION_REPOSITORY)
    private readonly accountSessionRepository: typeof AccountSession,
  ) {}

  async findAll(
    tenantId: string,
    pagination?: BaseGetAllUrlQuery,
    filter?: IAccountGetFilter,
  ) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const { limit, offset, order }
        = this.paginationProvider.generatePaginationQuery(pagination);

      const whereOptions: WhereOptions = {};
      const variantInclude: any = {
        model: ProductVariant,
        as: 'product_variant',
        include: [{ 
          model: Product, 
          as: 'product',
          required: false,
          where: undefined as any
        }],
        required: false,
        where: undefined as any
      };

      if (filter?.email_id) {
        whereOptions.email_id = filter.email_id;
      }
      if (filter?.product_variant_id) {
        whereOptions.product_variant_id = filter.product_variant_id;
      }
      
      if (filter?.product_id) {
        variantInclude.where = { product_id: filter.product_id };
        variantInclude.required = true;
      }
      
      if (filter?.product_slug) {
        variantInclude.include[0].where = { slug: filter.product_slug };
        variantInclude.include[0].required = true;
        variantInclude.required = true;
      }

      if (filter?.billing) {
        whereOptions.billing = { [Op.iLike]: `%${filter.billing}%` };
      }

      // Email and User search will be handled within the include blocks to ensure correct joining


      if (filter?.status) {
        if (filter.status === 'freeze') {
          whereOptions.freeze_until = { [Op.ne]: null };
        }
        else if (filter.status === 'disable') {
          whereOptions.status = 'disable';
          whereOptions.freeze_until = null;
        }
        else if (filter.status === 'banned') {
          whereOptions.status = 'banned';
          whereOptions.freeze_until = null;
        }
        else if (filter.status === 'active') {
          whereOptions.freeze_until = null;
          whereOptions.status = { [Op.notIn]: ['disable', 'banned'] };
          whereOptions.id = {
            [Op.in]: Sequelize.literal(
              '(SELECT account_id FROM account_user WHERE status = \'active\')',
            ),
          };
        }
        else if (filter.status === 'ready') {
          whereOptions.freeze_until = null;
          whereOptions.status = { [Op.notIn]: ['disable', 'banned'] };
          whereOptions.id = {
            [Op.notIn]: Sequelize.literal(
              '(SELECT account_id FROM account_user WHERE status = \'active\')',
            ),
          };
        }
        else if (filter.status === 'expiring_today') {
           whereOptions.freeze_until = null;
           whereOptions.status = { [Op.notIn]: ['disable', 'banned'] };
           whereOptions.subscription_expiry = {
              [Op.ne]: null,
           };
           whereOptions.id = {
             [Op.in]: Sequelize.literal(`
                (SELECT a.id FROM account a
                 WHERE DATE(a.subscription_expiry AT TIME ZONE 'Asia/Jakarta') = DATE(NOW() AT TIME ZONE 'Asia/Jakarta')
                )
             `)
           }
        }
        else if (filter.status === 'reset_today') {
           whereOptions.freeze_until = null;
           whereOptions.status = { [Op.notIn]: ['disable', 'banned'] };
           whereOptions.id = {
             [Op.in]: Sequelize.literal(`
                (SELECT a.id FROM account a
                 WHERE DATE(
                   COALESCE((
                     SELECT MAX(au.expired_at)
                     FROM account_user au
                     JOIN account_profile ap ON ap.id = au.account_profile_id
                     WHERE ap.account_id = a.id AND au.status = 'active'
                   ), a.batch_end_date) AT TIME ZONE 'Asia/Jakarta'
                 ) = DATE(NOW() AT TIME ZONE 'Asia/Jakarta')
                )
             `)
           };
        }
      }

      // Process order: handle nested models if necessary (e.g. email.email)
      const finalOrder: any[] = [['pinned', 'DESC']];
      
      if (order && order.length > 0) {
        for (const o of order) {
          const [col, dir] = o as [string, string];
          if (col.includes('.')) {
            const parts = col.split('.');
            if (parts[0] === 'email') {
              finalOrder.push([{ model: Email, as: 'email' }, parts[1], dir]);
            }
            // Add other nested sorts here if needed
          } else {
            // Replace default fallback sorting by 'id' with 'updated_at' to sort recently edited/created first
            if (col === 'id') {
              finalOrder.push(['updated_at', 'DESC']);
            } else if (col === 'batch_end_date') {
              finalOrder.push([
                Sequelize.literal(`COALESCE((
                  SELECT MAX(au.expired_at)
                  FROM account_user au
                  JOIN account_profile ap ON ap.id = au.account_profile_id
                  WHERE ap.account_id = "Account".id AND au.status = 'active'
                ), "Account".batch_end_date)`),
                dir,
                'NULLS LAST'
              ]);
            } else if (col === 'subscription_expiry') {
              finalOrder.push([col, dir, 'NULLS LAST']);
            } else {
              finalOrder.push([col, dir]);
            }
          }
        }
      }

      // Add default secondary sorts
      finalOrder.push(['updated_at', 'DESC']);
      finalOrder.push([{ model: AccountProfile, as: 'profile' }, 'name', 'ASC']);

      const accounts = await this.accountRepository.findAndCountAll({
        where: whereOptions,
        order: finalOrder,
        limit,
        offset,
        distinct: true,
        include: [
          { 
            model: Email, 
            as: 'email',
            where: filter?.email ? { email: { [Op.iLike]: `%${filter.email}%` } } : undefined,
            required: !!filter?.email 
          },
          variantInclude,
          {
            model: AccountProfile,
            as: 'profile',
            required: !!filter?.user,
            include: [{ 
              model: AccountUser, 
              as: 'user',
              where: filter?.user 
                ? { name: { [Op.iLike]: `%${filter.user}%` }, status: 'active' } 
                : { status: 'active' },
              required: !!filter?.user
            }],
          },
          {
            model: Label,
            as: 'labels',
            where: filter?.label_ids ? { id: { [Op.in]: filter.label_ids.split(',') } } : undefined,
            required: !!filter?.label_ids,
          },
        ],
        transaction,
      });

      const accountIds = accounts.rows.map((a) => a.id);
      
      const financialStats: Record<string, { total_capital: number; total_revenue: number }> = {};
      
      if (accountIds.length > 0) {
        const capitals = await this.postgresProvider.rawQuery(
          `SELECT account_id, COALESCE(SUM(amount), 0) as total_capital 
           FROM account_capital 
           WHERE account_id IN (:accountIds)
           GROUP BY account_id`,
          {
            replacements: { accountIds },
            type: QueryTypes.SELECT,
            transaction,
          }
        );
        
        const revenues = await this.postgresProvider.rawQuery(
          `SELECT au.account_id, COALESCE(SUM(t.total_price), 0) as total_revenue
           FROM account_user au
           JOIN transaction_item ti ON ti.account_user_id = au.id
           JOIN transaction t ON t.id = ti.transaction_id
           WHERE au.account_id IN (:accountIds)
           GROUP BY au.account_id`,
          {
            replacements: { accountIds },
            type: QueryTypes.SELECT,
            transaction,
          }
        );
        
        for (const id of accountIds) {
          financialStats[id] = { total_capital: 0, total_revenue: 0 };
        }
        for (const cap of capitals as any[]) {
          financialStats[cap.account_id].total_capital = Number(cap.total_capital);
        }
        for (const rev of revenues as any[]) {
          financialStats[rev.account_id].total_revenue = Number(rev.total_revenue);
        }
      }

      const rowsWithStats = accounts.rows.map((acc) => {
        const stats = financialStats[acc.id] || { total_capital: 0, total_revenue: 0 };
        const total_capital = Number(acc.capital_price || 0) + stats.total_capital;
        const total_revenue = stats.total_revenue;
        const profit = total_revenue - total_capital;
        const roi = total_capital > 0 ? Math.round((profit / total_capital) * 100) : 0;
        
        const plainAcc = acc.get({ plain: true });
        return {
          ...plainAcc,
          total_capital,
          total_revenue,
          profit,
          roi
        };
      });

      await transaction.commit();
      return this.paginationProvider.generatePaginationResponse(
        rowsWithStats,
        accounts.count,
        pagination,
      );
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async findOne(tenantId: string, accountId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [{ model: Product, as: 'product' }],
          },
          {
            model: AccountProfile,
            as: 'profile',
            include: [{ 
              model: AccountUser, 
              as: 'user',
              where: { status: 'active' },
              required: false 
            }],
          },
          { model: Label, as: 'labels' },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException(
          `account dengan id: ${accountId} tidak ditemukan`,
        );
      }

      await transaction.commit();
      return account;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async countStatusAccount(
    tenantId: string,
    filter: { product_variant_id?: string; product_id?: string; product_slug?: string },
  ) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const where: any = {};
      if (filter.product_variant_id) {
        where.product_variant_id = filter.product_variant_id;
      }

      const include: any[] = [];
      if (filter.product_id || filter.product_slug) {
        const variantWhere: any = {};
        if (filter.product_id) variantWhere.product_id = filter.product_id;
        
        const productInclude: any = { model: Product, as: 'product', attributes: [] };
        if (filter.product_slug) productInclude.where = { slug: filter.product_slug };

        include.push({
          model: ProductVariant,
          as: 'product_variant',
          attributes: [],
          where: variantWhere,
          include: [productInclude],
        });
      }

      const accounts = await this.accountRepository.findAll({
        where,
        attributes: ['id', 'status', 'freeze_until', 'subscription_expiry', 'batch_end_date'],
        include: [
          ...include,
          {
            model: AccountProfile,
            as: 'profile',
            attributes: ['id', 'max_user', 'allow_generate'],
            include: [{ 
              model: AccountUser, 
              as: 'user',
              attributes: ['id', 'expired_at'],
              where: { status: 'active' },
              required: false 
            }],
          }
        ],
        transaction,
      });

      const stats = {
        accounts_with_slots: 0,
        profiles_available: 0,
        accounts_full: 0,
        accounts_disabled_or_frozen: 0,
        profiles_locked_but_has_slot: 0,
        accounts_expiring_today: 0,
        accounts_reset_today: 0,
      };

      const getWibDateStr = (date: Date | string | number) => {
        const d = new Date(date);
        const wibTime = d.getTime() + (7 * 60 * 60 * 1000);
        const wibDate = new Date(wibTime);
        return `${wibDate.getUTCFullYear()}-${wibDate.getUTCMonth()}-${wibDate.getUTCDate()}`;
      };

      const todayStr = getWibDateStr(new Date());

      for (const acc of accounts) {
        // Check disabled/frozen/banned
        if (acc.status === 'disable' || acc.status === 'banned' || acc.freeze_until) {
          stats.accounts_disabled_or_frozen++;
          continue;
        }

        // Check expiring today
        if (acc.subscription_expiry) {
          const expDateStr = getWibDateStr(acc.subscription_expiry);
          if (expDateStr === todayStr) {
            stats.accounts_expiring_today++;
          }
        }

        // Check reset today
        let latestUserExpiry: Date | null = null;
        if (acc.profile && acc.profile.length > 0) {
          for (const prof of acc.profile) {
            prof.user?.forEach(u => {
              if (u.expired_at) {
                const uDate = new Date(u.expired_at);
                if (!latestUserExpiry || uDate > latestUserExpiry) {
                   latestUserExpiry = uDate;
                }
              }
            });
          }
        }
        const resetDate = latestUserExpiry || acc.batch_end_date;
        if (resetDate) {
          const resetDateStr = getWibDateStr(resetDate);
          if (resetDateStr === todayStr) {
            stats.accounts_reset_today++;
          }
        }

        let accountHasSlot = false;
        let accountIsFull = true;

        if (acc.profile && acc.profile.length > 0) {
          for (const prof of acc.profile) {
            const activeCount = prof.user?.length || 0;
            const available = Math.max(0, prof.max_user - activeCount);

            if (prof.allow_generate) {
              if (available > 0) {
                accountHasSlot = true;
                stats.profiles_available += available;
              }
              if (available > 0) {
                accountIsFull = false;
              }
            } else {
              if (available > 0) {
                stats.profiles_locked_but_has_slot++;
              }
            }
          }
        } else {
          // If no profiles, consider it full or not ready for generate
          accountIsFull = true;
        }

        if (accountHasSlot) {
          stats.accounts_with_slots++;
        } else if (accountIsFull) {
          stats.accounts_full++;
        }
      }

      await transaction.commit();
      return stats;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async create(tenantId: string, createAccountDto: CreateAccountDto) {
    const { profile, ...accountData } = createAccountDto;

    let account: Account | null;
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const existingAccount = await this.accountRepository.count({
        where: {
          email_id: accountData.email_id,
          product_variant_id: accountData.product_variant_id,
        },
        transaction,
      });

      if (existingAccount) {
        throw new BadRequestException(
          'Akun dengan email dan varian produk sudah ada',
        );
      }

      if (accountData.status === 'freeze') {
        const freezeUntil = new Date();
        freezeUntil.setDate(freezeUntil.getDate() + 7);
        (accountData as any).freeze_until = freezeUntil;
      }

      const newAccount = await this.accountRepository.create(accountData, {
        transaction,
      });

      const profileData = profile.map(p => ({
        ...p,
        account_id: newAccount.id,
      }));
      await this.accountProfileRepository.bulkCreate(profileData, {
        transaction,
      });

      account = await this.accountRepository.findOne({
        where: { id: newAccount.id },
        include: [
          { model: Email, as: 'email' },
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [{ model: Product, as: 'product' }],
          },
          {
            model: AccountProfile,
            as: 'profile',
            include: [{ model: AccountUser, as: 'user' }],
          },
        ],
        transaction,
      });

      await transaction.commit();
      
      if (account) {
        this.registerAutomaticTasks(tenantId, account).catch(err => {
          this.logger.error(`Failed to register automatic tasks for account ${account?.id}: ${err.message}`);
        });
      }
      return account;
    }
    catch (error) {
      if (transaction && !(transaction as any).finished) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  async bulkCreate(tenantId: string, bulkCreateAccountDto: BulkCreateAccountDto) {
    const transaction = await this.postgresProvider.transaction();
    let createdAccountsCount = 0;
    let createdProfilesCount = 0;
    const skippedEmails: string[] = [];
    
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      for (const accountItem of bulkCreateAccountDto.accounts) {
        const { profile, email, ...accountData } = accountItem;

        // 1. Find or create the email
        const [emailRecord] = await this.emailRepository.findOrCreate({
          where: { email },
          defaults: { email },
          transaction,
        });

        // 2. Check if account already exists
        const existingAccount = await this.accountRepository.count({
          where: {
            email_id: emailRecord.id,
            product_variant_id: accountData.product_variant_id,
          },
          transaction,
        });

        // Skip if account already exists to prevent failing the entire batch
        if (existingAccount) {
          skippedEmails.push(email);
          continue;
        }

        if (accountData.status === 'freeze') {
          const freezeUntil = new Date();
          freezeUntil.setDate(freezeUntil.getDate() + 7);
          (accountData as any).freeze_until = freezeUntil;
        }

        // 3. Create the account
        const newAccount = await this.accountRepository.create({
          ...accountData,
          email_id: emailRecord.id,
        }, {
          transaction,
        });

        createdAccountsCount++;

        // 4. Create profiles
        if (profile && profile.length > 0) {
          const profileData = profile.map(p => ({
            ...p,
            account_id: newAccount.id,
          }));
          
          await this.accountProfileRepository.bulkCreate(profileData, {
            transaction,
          });
          
          createdProfilesCount += profileData.length;
        }
      }

      await transaction.commit();
      
      const skippedInfo = skippedEmails.length > 0
        ? ` ${skippedEmails.length} akun dilewati karena sudah ada: ${skippedEmails.join(', ')}.`
        : '';

      return {
        success: true,
        message: `Berhasil membuat ${createdAccountsCount} akun dan ${createdProfilesCount} profil.${skippedInfo}`,
        created_accounts: createdAccountsCount,
        created_profiles: createdProfilesCount,
        skipped_accounts: skippedEmails,
      };
    } catch (error) {
      if (transaction && !(transaction as any).finished) {
        await transaction.rollback();
      }
      throw error;
    }
  }


  async update(
    tenantId: string,
    accountId: string,
    updateAccountDto: UpdateAccountDto,
  ) {
    let accountUpdateData: Partial<AccountCreationAttributes>;
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      let account = await this.accountRepository.findOne({
        where: { id: accountId },
        transaction,
      });

      if (!account) {
        throw new NotFoundException(
          `account dengan id: ${accountId} tidak ditemukan`,
        );
      }

      accountUpdateData = {
        ...updateAccountDto,
      };
       if (updateAccountDto.status && updateAccountDto.status !== 'active') {
        // Raw SQL for robustness
        await this.postgresProvider.rawQuery(
          'UPDATE account_user SET status = \'expired\', expired_at = :now WHERE account_id = :accountId AND status = \'active\'',
          {
            replacements: { accountId, now: new Date() },
            transaction,
            type: QueryTypes.UPDATE,
          },
        );
        accountUpdateData.batch_start_date = null;
        accountUpdateData.batch_end_date = null;
      }

      if (updateAccountDto.status === 'freeze') {
        if (!account.freeze_until) {
          const freezeUntil = new Date();
          freezeUntil.setDate(freezeUntil.getDate() + 7);
          (accountUpdateData as any).freeze_until = freezeUntil;
        }
      }
      else if (updateAccountDto.status && updateAccountDto.status !== 'freeze') {
        (accountUpdateData as any).freeze_until = null;
      }

      if (updateAccountDto.switch_to_harian) {
        const currentAccount = await this.accountRepository.findOne({
          where: { id: accountId },
          include: [{ model: ProductVariant, as: 'product_variant' }],
          transaction,
        });

        if (currentAccount?.product_variant?.product_id) {
          const harianVariant = await this.productVariantRepository.findOne({
            where: {
              product_id: currentAccount.product_variant.product_id,
              name: { [Op.iLike]: '%Harian%' },
            },
            transaction,
          });

          if (harianVariant) {
            accountUpdateData.product_variant_id = harianVariant.id;
          }
        }
      }

      await account.update(accountUpdateData, { transaction });

      // Refetch account with includes INSIDE transaction for task registration and response
      account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [{ model: Product, as: 'product' }],
          },
        ],
        transaction,
      });

      await transaction.commit();

      if (
        account
        && (accountUpdateData.batch_end_date
          || accountUpdateData.subscription_expiry
          || accountUpdateData.product_variant_id
          || (updateAccountDto.status === 'ready' || updateAccountDto.status === 'active'))
      ) {
        this.registerAutomaticTasks(
          tenantId,
          account,
        ).catch(err => {
          this.logger.error(`Failed to register automatic tasks for account ${accountId}: ${err.message}`);
        });
      }

      // Handle task removal if disabled/frozen/banned or ready (cleared) in background
      if (updateAccountDto.status && updateAccountDto.status !== 'active') {
        const contexts = [NETFLIX_RESET_PASSWORD, SUBS_END_NOTIFY];
        if (updateAccountDto.status !== 'freeze') {
          contexts.push(UNFREEZE_ACCOUNT);
        }
        this.taskQueueService.removeByAccount(tenantId, accountId, contexts).catch(err => {
          this.logger.error(`Failed to remove tasks for account ${accountId}: ${err.message}`);
        });
      }

      return account;
    }
    catch (error) {
      if (transaction && !(transaction as any).finished) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  async remove(tenantId: string, accountId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        transaction,
      });

      if (!account) {
        throw new NotFoundException(
          `account dengan id: ${accountId} tidak ditemukan`,
        );
      }

      await account.destroy({ transaction });
      await transaction.commit();

      // Cleanup tasks in background
      this.taskQueueService.removeByAccount(tenantId, accountId, [NETFLIX_RESET_PASSWORD, SUBS_END_NOTIFY, UNFREEZE_ACCOUNT]).catch(err => {
        this.logger.error(`Failed to cleanup tasks for deleted account ${accountId}: ${err.message}`);
      });

    }
    catch (error) {
      if (transaction && !(transaction as any).finished) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  async freezeAccount(tenantId: string, accountId: string, freezeAccountDto: FreezeAccountDto) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        transaction,
      });

      if (!account) {
        throw new NotFoundException(
          `account dengan id: ${accountId} tidak ditemukan`,
        );
      }

      // Calculate freeze_until from duration (milliseconds)
      // Default to 7 days if duration is not provided: 7 * 24 * 60 * 60 * 1000
      const durationMs = freezeAccountDto.duration || (7 * 24 * 60 * 60 * 1000);
      const freezeUntil = new Date(Date.now() + durationMs);

      // 1. Expire users
      await this.postgresProvider.rawQuery(
        'UPDATE account_user SET status = \'expired\' WHERE account_id = :accountId AND status = \'active\'',
        {
          replacements: { accountId },
          transaction,
          type: QueryTypes.UPDATE,
        },
      );

      // 2. Set freeze until & status
      await account.update(
        {
          status: 'freeze',
          freeze_until: freezeUntil,
          batch_start_date: null,
          batch_end_date: null,
        },
        { transaction },
      );

      await transaction.commit();

      // Register unfreeze task in background
      const payload: any = { accountId };
      this.taskQueueService.upsert([{
        execute_at: freezeUntil,
        subject_id: accountId,
        context: UNFREEZE_ACCOUNT,
        payload: JSON.stringify(payload),
        status: 'QUEUED',
        tenant_id: tenantId,
      }]).catch(err => {
        this.logger.error(`Failed to register unfreeze task for account ${accountId}: ${err.message}`);
      });

      // Cleanup existing automation tasks
      this.taskQueueService.removeByAccount(tenantId, accountId, [NETFLIX_RESET_PASSWORD, SUBS_END_NOTIFY]).catch(err => {
        this.logger.error(`Failed to cleanup automation tasks for frozen account ${accountId}: ${err.message}`);
      });

      return account;
    }
    catch (error) {
      if (transaction && !(transaction as any).finished) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  async clearFreezeAccount(tenantId: string, accountId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        transaction,
      });

      if (!account) {
        throw new NotFoundException(
          `account dengan id: ${accountId} tidak ditemukan`,
        );
      }

      await account.update(
        { status: 'ready', freeze_until: null, batch_start_date: null, batch_end_date: null },
        { transaction },
      );

      // Refetch for task registration INSIDE transaction
      const updatedAccount = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          {
            model: ProductVariant,
            as: 'product_variant',
            include: [{ model: Product, as: 'product' }],
          },
        ],
        transaction,
      });

      await transaction.commit();

      if (updatedAccount) {
        this.registerAutomaticTasks(tenantId, updatedAccount).catch(err => {
          this.logger.error(`Failed to register automatic tasks for unfrozen account ${accountId}: ${err.message}`);
        });
      }

      // Cleanup unfreeze task
      this.taskQueueService.removeByAccount(tenantId, accountId, [UNFREEZE_ACCOUNT]).catch(err => {
        this.logger.error(`Failed to remove unfreeze task for account ${accountId}: ${err.message}`);
      });

      return updatedAccount;
    }
    catch (error) {
      if (transaction && !(transaction as any).finished) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  async registerAutomaticTasks(
    tenantId: string,
    account: Account,
  ) {
    // Check if it's a Netflix product
    const productName = account.product_variant?.product?.name?.toLowerCase() || '';
    const isNetflix = productName.includes('netflix');

    if (isNetflix) {
      await this.registerNetflixResetTask(tenantId, account);
    }
    
    // Add default SUBS_END_NOTIFY if needed (e.g. 1 day before)
    await this.registerDefaultSubsNotifyTask(tenantId, account);
  }

  async registerNetflixResetTask(tenantId: string, account: Account) {
    if (!account.batch_end_date) return;

    await this.taskQueueService.upsert([{
      context: NETFLIX_RESET_PASSWORD,
      execute_at: account.batch_end_date,
      subject_id: account.id,
      tenant_id: tenantId,
      status: 'QUEUED',
      payload: JSON.stringify({
        id: account.id,
        accountId: account.id,
        email: account.email?.email || '',
        password: account.account_password,
        newPassword: '', // Bot will generate its own password
        subscription_expiry: account.subscription_expiry?.toISOString() || '',
        variant_name: account.product_variant?.name || '',
      } as NetflixResetPasswordPayload),
    }]);
  }

  async registerDefaultSubsNotifyTask(tenantId: string, account: Account) {
    if (!account.subscription_expiry) return;

    const dday = new Date(account.subscription_expiry);
    dday.setHours(7, 0, 0, 0);

    const minDDay = new Date(account.subscription_expiry);
    minDDay.setHours(7, 0, 0, 0);
    minDDay.setDate(minDDay.getDate() - 1); // Default notify 1 day before

    const dDayFormatted = this.dateConverterProvider.formatDateIdStandard(
      account.subscription_expiry,
      { hideTime: true },
    );

    await this.taskQueueService.upsert([
      {
        context: SUBS_END_NOTIFY,
        execute_at: dday,
        subject_id: account.id,
        tenant_id: tenantId,
        status: 'QUEUED',
        payload: JSON.stringify({
          context: 'NEED_ACTION',
          tenant_id: tenantId,
          message: `Langganan (Subscription) akun ${account.email.email} [${account.product_variant.product.name}] telah berakhir hari ini ${dDayFormatted}.\n\nSilahkan lakukan tindakan`,
        } as AccountSubsEndNotifyPayload),
      },
      {
        context: SUBS_END_NOTIFY,
        execute_at: minDDay,
        subject_id: account.id,
        tenant_id: tenantId,
        status: 'QUEUED',
        payload: JSON.stringify({
          context: 'NEED_ACTION',
          tenant_id: tenantId,
          message: `Langganan (Subscription) akun ${account.email.email} [${account.product_variant.product.name}] akan berakhir 1 hari lagi pada ${dDayFormatted}.\n\nSilahkan lakukan tindakan`,
        } as AccountSubsEndNotifyPayload),
      }
    ]);
  }

  async triggerReset(tenantId: string, accountId: string, targetBot?: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          { model: ProductVariant, as: 'product_variant' },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException('Account not found');
      }

      if (account.status === 'banned') {
        throw new BadRequestException('Cannot trigger task for banned account');
      }

      const payload: NetflixResetPasswordPayload = {
        id: account.id,
        accountId: account.id,
        email: account.email.email,
        password: account.account_password,
        newPassword: '',
        subscription_expiry: account.subscription_expiry.toISOString(),
        variant_name: account.product_variant.name,
        target_bot: targetBot,
      };

      await transaction.commit();

      const taskId = await this.taskQueueService.enqueueImmediate(
        tenantId,
        account.id,
        NETFLIX_RESET_PASSWORD,
        payload
      );

      return { message: 'Reset password task triggered successfully', taskId };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async triggerReload(tenantId: string, accountId: string, targetBot?: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          { model: ProductVariant, as: 'product_variant' },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException('Account not found');
      }

      if (account.status === 'banned') {
        throw new BadRequestException('Cannot trigger task for banned account');
      }

      const payload: NetflixAutoReloadPayload = {
        accountId: account.id,
        email: account.email.email,
        password: account.account_password,
        billing: account.billing || '',
        variant_name: account.product_variant.name,
        target_bot: targetBot,
      };

      await transaction.commit();

      const taskId = await this.taskQueueService.enqueueImmediate(
        tenantId,
        account.id,
        NETFLIX_AUTO_RELOAD,
        payload
      );

      return { message: 'Auto reload task triggered successfully', taskId };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async triggerUpgrade(tenantId: string, accountId: string, targetBot?: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          { model: ProductVariant, as: 'product_variant' },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException('Account not found');
      }

      if (account.status === 'banned') {
        throw new BadRequestException('Cannot trigger task for banned account');
      }

      const payload: any = {
        accountId: account.id,
        email: account.email.email,
        password: account.account_password,
        subscription_expiry: account.subscription_expiry.toISOString(),
        variant_name: account.product_variant.name,
        target_bot: targetBot,
      };

      await transaction.commit();

      const taskId = await this.taskQueueService.enqueueImmediate(
        tenantId,
        account.id,
        NETFLIX_AUTO_UPGRADE,
        payload
      );

      return { message: 'Auto upgrade task triggered successfully', taskId };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async triggerLoginTv(tenantId: string, accountId: string, targetBot?: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: Email, as: 'email' },
          { model: ProductVariant, as: 'product_variant' },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException('Account not found');
      }

      if (account.status === 'banned') {
        throw new BadRequestException('Cannot trigger task for banned account');
      }

      const payload = {
        accountId: account.id,
        email: account.email.email,
        password: account.account_password,
        variant_name: account.product_variant.name,
        target_bot: targetBot,
      };

      await transaction.commit();

      const taskId = await this.taskQueueService.enqueueImmediate(
        tenantId,
        account.id,
        NETFLIX_LOGIN_TV,
        payload
      );

      return { message: 'Login TV task triggered successfully', taskId };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getFinancialDetails(tenantId: string, accountId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const account = await this.accountRepository.findOne({
        where: { id: accountId },
        include: [
          { model: AccountCapital, as: 'capitals' },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException(`Account with ID ${accountId} not found`);
      }

      // Calculate totals
      const totalCapital = account.dataValues.capitals?.reduce((acc, cap) => acc + Number(cap.amount), 0) || 0;
      
      // Get revenue from account_user by joining transaction
      const revenueData = await this.postgresProvider.rawQuery(
        `SELECT COALESCE(SUM(t.total_price), 0) as total_revenue
         FROM account_user au
         JOIN transaction_item ti ON ti.account_user_id = au.id
         JOIN transaction t ON t.id = ti.transaction_id
         WHERE au.account_id = :accountId`,
        {
          replacements: { accountId },
          type: QueryTypes.SELECT,
          transaction,
        }
      );
      const totalRevenue = Number((revenueData[0] as any).total_revenue) || 0;

      // Get revenue history
      const revenueHistory = await this.postgresProvider.rawQuery(
        `SELECT t.id as transaction_id, t.total_price as amount, t.created_at as date, au.name as user_name
         FROM account_user au
         JOIN transaction_item ti ON ti.account_user_id = au.id
         JOIN transaction t ON t.id = ti.transaction_id
         WHERE au.account_id = :accountId
         ORDER BY t.created_at DESC`,
        {
          replacements: { accountId },
          type: QueryTypes.SELECT,
          transaction,
        }
      );

      await transaction.commit();
      return {
        total_capital: totalCapital,
        total_revenue: totalRevenue,
        profit: totalRevenue - totalCapital,
        capitals: account.dataValues.capitals || [],
        revenues: revenueHistory || [],
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async addCapital(tenantId: string, accountId: string, dto: any) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      let expense_coa_id = dto.expense_coa_id;
      if (!expense_coa_id) {
        const accForCoa = await this.accountRepository.findOne({
          where: { id: accountId },
          include: [{ model: ProductVariant, as: 'product_variant' }],
          transaction
        });
        if (accForCoa?.product_variant) {
          expense_coa_id = (accForCoa.product_variant as any).inventory_coa_id || (accForCoa.product_variant as any).expense_coa_id;
        }
      }

      const capital = await this.accountCapitalRepository.create({
        account_id: accountId,
        amount: dto.amount,
        note: dto.description || dto.note || 'Manual Add',
        payment_coa_id: dto.payment_coa_id,
        expense_coa_id: expense_coa_id,
        created_at: dto.date ? new Date(dto.date) : new Date(),
      }, { transaction });

      await transaction.commit();
      return capital;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async editCapital(tenantId: string, accountId: string, capitalId: string, dto: any) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const capital = await this.accountCapitalRepository.findOne({
        where: { id: capitalId, account_id: accountId },
        transaction,
      });

      if (!capital) {
        throw new NotFoundException(`Capital entry with ID ${capitalId} not found`);
      }

      let updateSql = `UPDATE account_capital SET amount = :amount, note = :note`;
      const replacements: any = {
        amount: dto.amount !== undefined ? dto.amount : capital.amount,
        note: dto.note !== undefined ? dto.note : capital.note,
        capitalId
      };

      if (dto.date) {
        updateSql += `, created_at = :created_at`;
        replacements.created_at = new Date(dto.date);
      }
      if (dto.payment_coa_id !== undefined) {
        updateSql += `, payment_coa_id = :payment_coa_id`;
        replacements.payment_coa_id = dto.payment_coa_id;
      }
      if (dto.expense_coa_id !== undefined) {
        updateSql += `, expense_coa_id = :expense_coa_id`;
        replacements.expense_coa_id = dto.expense_coa_id;
      }
      
      updateSql += ` WHERE id = :capitalId`;

      await this.postgresProvider.rawQuery(updateSql, {
        replacements,
        transaction,
        type: QueryTypes.UPDATE,
      });

      await transaction.commit();
      return capital;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async deleteCapital(tenantId: string, accountId: string, capitalId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const capital = await this.accountCapitalRepository.findOne({
        where: { id: capitalId, account_id: accountId },
        transaction,
      });

      if (!capital) {
        throw new NotFoundException(`Capital entry with ID ${capitalId} not found`);
      }

      await capital.destroy({ transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  clearPendingTopup(tenantId: string, accountId: string) {
    const key = `${tenantId}:${accountId}`;
    this.pendingTopupStore.delete(key);
  }
  async bulkAction(
    tenantId: string,
    ids: string[],
    action: string,
    payload?: any
  ) {
    this.logger.log(`[bulkAction] action: ${action} | ids: ${ids.length} | payload: ${JSON.stringify(payload)}`, 'AccountService');
    const transaction = await this.postgresProvider.transaction();
    let isCommitted = false;
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      switch (action) {
        case 'add_modal':
          for (const id of ids) {
            const payment_coa_id = payload.payment_coas?.[id];
            const amount = payload.amounts?.[id] || payload.amount;
            if (!amount) throw new BadRequestException('Nominal modal (amount) wajib diisi untuk semua akun');
            await this.addCapital(tenantId, id, { 
              amount: amount, 
              description: payload.note, 
              payment_coa_id 
            });
          }
          break;
        case 'enable':
          await this.accountRepository.update(
            { status: 'ready', freeze_until: null, batch_start_date: null, batch_end_date: null },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          await this.postgresProvider.rawQuery(
            'UPDATE account_user SET status = \'expired\', expired_at = :now WHERE account_id IN (:ids) AND status = \'active\'',
            {
              replacements: { ids, now: new Date() },
              transaction,
              type: QueryTypes.UPDATE,
            },
          );
          break;
        case 'disable':
          await this.accountRepository.update(
            { status: 'disable', batch_start_date: null, batch_end_date: null },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          await this.postgresProvider.rawQuery(
            'UPDATE account_user SET status = \'expired\', expired_at = :now WHERE account_id IN (:ids) AND status = \'active\'',
            {
              replacements: { ids, now: new Date() },
              transaction,
              type: QueryTypes.UPDATE,
            },
          );
          break;
        case 'banned':
          await this.accountRepository.update(
            { status: 'banned', batch_start_date: null, batch_end_date: null },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          await this.postgresProvider.rawQuery(
            'UPDATE account_user SET status = \'expired\', expired_at = :now WHERE account_id IN (:ids) AND status = \'active\'',
            {
              replacements: { ids, now: new Date() },
              transaction,
              type: QueryTypes.UPDATE,
            },
          );
          break;
        case 'pin':
          await this.accountRepository.update(
            { pinned: true },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          break;
        case 'unpin':
          await this.accountRepository.update(
            { pinned: false },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          break;
        case 'freeze':
          const freezeUntil = new Date();
          freezeUntil.setDate(freezeUntil.getDate() + 7); // Default 7 hari
          await this.accountRepository.update(
            { status: 'freeze', freeze_until: freezeUntil, batch_start_date: null, batch_end_date: null },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          await this.postgresProvider.rawQuery(
            'UPDATE account_user SET status = \'expired\' WHERE account_id IN (:ids) AND status = \'active\'',
            {
              replacements: { ids },
              transaction,
              type: QueryTypes.UPDATE,
            },
          );
          break;
        case 'unfreeze':
          await this.accountRepository.update(
            { status: 'ready', freeze_until: null, batch_start_date: null, batch_end_date: null },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          break;
        case 'edit':
          if (payload) {
            const updatePayload: any = {};
            if (payload.account_password !== undefined) updatePayload.account_password = payload.account_password;
            if (payload.subscription_expiry !== undefined) updatePayload.subscription_expiry = payload.subscription_expiry;
            if (payload.status !== undefined) {
              updatePayload.status = payload.status;
              if (payload.status === 'freeze') {
                const freezeUntil = new Date();
                freezeUntil.setDate(freezeUntil.getDate() + 7);
                updatePayload.freeze_until = freezeUntil;
                updatePayload.batch_start_date = null;
                updatePayload.batch_end_date = null;
              } else {
                updatePayload.freeze_until = null;
              }
            }
            if (payload.billing !== undefined) updatePayload.billing = payload.billing;
            if (payload.product_variant_id !== undefined) updatePayload.product_variant_id = payload.product_variant_id;

            if (payload.label_id !== undefined) {
              const validAccounts = await this.accountRepository.findAll({
                where: { id: { [Op.in]: ids }, status: { [Op.ne]: 'banned' } },
                attributes: ['id'],
                transaction
              });
              for (const acc of validAccounts) {
                const existing = await this.accountLabelRepository.findOne({
                  where: { account_id: acc.id, label_id: payload.label_id },
                  transaction
                });
                if (!existing) {
                  await this.accountLabelRepository.create({
                    account_id: acc.id,
                    label_id: payload.label_id,
                  }, { transaction });
                }
              }
            }

            if (Object.keys(updatePayload).length > 0) {
              await this.accountRepository.update(
                updatePayload,
                { where: { id: { [Op.in]: ids }, status: { [Op.ne]: 'banned' } }, transaction }
              );
            }
          }
          break;
        case 'delete':
          await this.accountRepository.destroy({
            where: { id: { [Op.in]: ids } },
            transaction
          });
          break;
        case 'clear':
          // 1. Expire semua user yang terhubung ke akun-akun ini
          await this.postgresProvider.rawQuery(
            'UPDATE account_user SET status = \'expired\', expired_at = :now WHERE account_id IN (:ids) AND status = \'active\'',
            {
              replacements: { ids, now: new Date() },
              transaction,
              type: QueryTypes.UPDATE,
            },
          );
          // 2. Kosongkan metadata di profil akun
          await this.accountProfileRepository.update(
            { metadata: JSON.stringify([]) },
            { where: { account_id: { [Op.in]: ids } }, transaction }
          );
          // 3. Kembalikan status akun menjadi 'ready' dan hapus tanggal batch
          await this.accountRepository.update(
            { status: 'ready', batch_start_date: null, batch_end_date: null },
            { where: { id: { [Op.in]: ids } }, transaction }
          );
          break;
        case 'reset_now':
        case 'auto_reload':
        case 'auto_upgrade':
        case 'login_tv':
          // Trigger bot tasks for all selected IDs
          const tasks: UpsertTaskQueueDto[] = [];
          const accounts = await this.accountRepository.findAll({
            where: { 
              id: { [Op.in]: ids },
              status: { [Op.ne]: 'banned' }
            },
            include: [
              { model: Email, as: 'email' },
              { model: ProductVariant, as: 'product_variant' }
            ],
            transaction
          });

          for (const account of accounts) {
            let taskPayload: any;
            let taskType: string;

            if (action === 'reset_now') {
              taskType = NETFLIX_RESET_PASSWORD;
              taskPayload = {
                id: `${Date.now()}-${account.id}-${Math.random().toString(36).substring(2, 7)}`,
                accountId: account.id,
                email: account.email?.email || account.email_id,
                password: account.account_password,
                newPassword: '',
                subscription_expiry: account.subscription_expiry?.toISOString() || '',
                variant_name: account.product_variant?.name || '',
                target_bot: payload?.target_bot,
              };
            } else if (action === 'auto_reload') {
              taskType = NETFLIX_AUTO_RELOAD;
              taskPayload = {
                accountId: account.id,
                email: account.email?.email || account.email_id,
                password: account.account_password,
                billing: account.billing,
                variant_name: account.product_variant?.name || '',
                target_bot: payload?.target_bot,
              };
            } else if (action === 'login_tv') {
              taskType = NETFLIX_LOGIN_TV;
              taskPayload = {
                accountId: account.id,
                email: account.email?.email || account.email_id,
                password: account.account_password,
                target_bot: payload?.target_bot,
              };
            } else {
              taskType = NETFLIX_AUTO_UPGRADE;
              taskPayload = {
                accountId: account.id,
                email: account.email?.email || account.email_id,
                password: account.account_password,
                subscription_expiry: account.subscription_expiry?.toISOString() || '',
                variant_name: account.product_variant?.name || '',
                target_bot: payload?.target_bot,
              };
            }

            tasks.push({
              execute_at: action === 'login_tv' ? new Date(Date.now() - 60000) : new Date(),
              subject_id: account.id,
              context: taskType,
              payload: JSON.stringify(taskPayload),
              status: 'QUEUED',
              tenant_id: tenantId,
            });
          }
          if (tasks.length > 0) {
            await this.taskQueueService.upsert(tasks);
          }
          break;
      }

      await transaction.commit();
      isCommitted = true;

      try {
        // Post-bulk action cleanup/registration
        if (['disable', 'freeze', 'banned', 'delete', 'clear', 'enable', 'unfreeze'].includes(action)) {
          const contexts = [NETFLIX_RESET_PASSWORD, SUBS_END_NOTIFY];
          if (['enable', 'unfreeze', 'clear'].includes(action)) {
            contexts.push(UNFREEZE_ACCOUNT);
          }
          // Batched remove for all IDs at once
          await this.taskQueueService.removeByAccount(tenantId, ids, contexts);
        }

        if (action === 'enable' || action === 'unfreeze') {
          const accounts = await this.accountRepository.findAll({
            where: { id: { [Op.in]: ids } },
            include: [
              { model: Email, as: 'email' },
              {
                model: ProductVariant,
                as: 'product_variant',
                include: [{ model: Product, as: 'product' }],
              }
            ],
          });
          for (const account of accounts) {
            this.registerAutomaticTasks(tenantId, account).catch(err => {
              this.logger.error(`Failed to register automatic tasks for account ${account.id} in bulk action: ${err.message}`);
            });
          }
        }
      }
      catch (postActionError) {
        this.logger.error(`Error in post-bulk-action cleanup: ${postActionError.message}`, postActionError.stack);
      }

      return { message: `Bulk ${action} completed for ${ids.length} accounts` };
    }
    catch (error) {
      if (transaction && !isCommitted) {
        await transaction.rollback();
      }
      throw error;
    }
  }
  async getPendingTopups(tenantId: string) {
    const now = new Date();
    const result: any[] = [];
    for (const [key, val] of this.pendingTopupStore.entries()) {
      if (val.tenantId !== tenantId) continue;
      const age = now.getTime() - val.createdAt.getTime();
      if (age > 15 * 60 * 1000) {
        this.pendingTopupStore.delete(key);
      } else {
        result.push(val);
      }
    }
    return result;
  }

  async registerPendingTopup(tenantId: string, accountId: string, payload: { email: string; billing: string; taskId: string }) {
    const now = new Date();
    for (const [key, val] of this.pendingTopupStore.entries()) {
      const age = now.getTime() - val.createdAt.getTime();
      if (age > 15 * 60 * 1000) {
        this.pendingTopupStore.delete(key);
      }
    }

    const key = `${tenantId}:${accountId}`;
    this.pendingTopupStore.set(key, {
      ...payload,
      accountId,
      tenantId,
      createdAt: new Date()
    });
    return { success: true, message: 'Topup request registered' };
  }

  async assignLabel(tenantId: string, accountId: string, labelId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const existing = await this.accountLabelRepository.findOne({
        where: { account_id: accountId, label_id: labelId },
        transaction,
      });

      if (!existing) {
        await this.accountLabelRepository.create({
          account_id: accountId,
          label_id: labelId,
        }, { transaction });
      }

      await transaction.commit();
      return { success: true };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async unassignLabel(tenantId: string, accountId: string, labelId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      await this.accountLabelRepository.destroy({
        where: { account_id: accountId, label_id: labelId },
        transaction,
      });

      await transaction.commit();
      return { success: true };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async moveAccountUser(tenantId: string, accountUserId: string, payload: { to_account_id: string; to_profile_id: string; reason: string; allow_old_profile_generate?: boolean }) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const accountUser = await this.accountUserRepository.findByPk(accountUserId, { transaction });
      if (!accountUser) {
        throw new NotFoundException('Account User tidak ditemukan');
      }

      const fromAccountId = accountUser.account_id;
      const fromProfileId = accountUser.account_profile_id;

      const targetAccount = await this.accountRepository.findByPk(payload.to_account_id, { transaction });
      if (!targetAccount) {
        throw new NotFoundException('Akun tujuan tidak ditemukan');
      }

      const targetProfile = await this.accountProfileRepository.findByPk(payload.to_profile_id, { transaction });
      if (!targetProfile) {
        throw new NotFoundException('Profil tujuan tidak ditemukan');
      }

      let newExpiredAt = accountUser.expired_at;

      if (fromAccountId !== payload.to_account_id) {
        const targetProfiles = await this.accountProfileRepository.findAll({
          where: { account_id: payload.to_account_id },
          include: [{
            model: AccountUser,
            as: 'user',
            where: { status: 'active' },
            required: false,
          }],
          transaction
        });

        let totalMaxUsers = 0;
        let totalActiveUsers = 0;
        let maxTargetExpiredAt: Date | null = targetAccount.batch_end_date ? new Date(targetAccount.batch_end_date) : null;

        for (const p of targetProfiles) {
          totalMaxUsers += p.max_user || 0;
          totalActiveUsers += p.user?.length || 0;
          
          if (p.user) {
            for (const u of p.user) {
              if (u.expired_at) {
                const uExp = new Date(u.expired_at);
                if (!maxTargetExpiredAt || uExp > maxTargetExpiredAt) {
                  maxTargetExpiredAt = uExp;
                }
              }
            }
          }
        }

        if (totalActiveUsers >= totalMaxUsers + 2) {
          throw new BadRequestException('Screenlimit Prevention: Akun tujuan sudah mencapai batas maksimal 2 user selipan.');
        }

        if (maxTargetExpiredAt && accountUser.expired_at) {
          const currentExp = new Date(accountUser.expired_at);
          if (currentExp > maxTargetExpiredAt) {
            newExpiredAt = maxTargetExpiredAt;
          }
        }
      }

      let originalEmailStr = '-';
      if (fromAccountId) {
        const fromAccount = await this.accountRepository.findByPk(fromAccountId, { include: ['email'], transaction });
        if (fromAccount && (fromAccount as any).email) {
            originalEmailStr = (fromAccount as any).email.email || (fromAccount as any).email_id || '-';
        } else if (fromAccount) {
            originalEmailStr = (fromAccount as any).email_id || '-';
        }
      }

      const originalExpText = accountUser.expired_at 
        ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short' }).format(new Date(accountUser.expired_at)).replace(' pukul', '') + ' WIB'
        : '-';

      const cleanName = accountUser.name.split(' | Pindahan dari')[0].trim();
      const newName = `${cleanName} | Pindahan dari ${originalEmailStr} original berakhir ${originalExpText}`;

      await this.accountUserMoveHistoryRepository.create({
        account_user_id: accountUserId,
        from_account_id: fromAccountId,
        from_profile_id: fromProfileId,
        to_account_id: payload.to_account_id,
        to_profile_id: payload.to_profile_id,
        reason: payload.reason,
      }, { transaction });

      await accountUser.update({
        account_id: payload.to_account_id,
        account_profile_id: payload.to_profile_id,
        expired_at: newExpiredAt,
        name: newName,
      }, { transaction });

      // Update old profile's allow_generate flag
      const allowOldProfileGenerate = payload.allow_old_profile_generate ?? false;
      await this.accountProfileRepository.update(
        { allow_generate: allowOldProfileGenerate },
        { where: { id: fromProfileId }, transaction }
      );

      await transaction.commit();
      return accountUser;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getAccountUserMoveRecommendations(tenantId: string, accountUserId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const accountUser = await this.accountUserRepository.findByPk(accountUserId, { 
        include: [{ model: Account, as: 'account', include: [{ model: ProductVariant, as: 'product_variant' }] }],
        transaction 
      });

      if (!accountUser) throw new NotFoundException('Account User tidak ditemukan');

      if (accountUser.status === 'expired' || (accountUser.expired_at && new Date(accountUser.expired_at).getTime() < Date.now())) {
        throw new BadRequestException(`durasi ${accountUser.name} sudah habis`);
      }

      const originalVariant = accountUser.account?.product_variant;
      if (!originalVariant) throw new BadRequestException('Produk Varian asal tidak ditemukan');

      const isDaily = originalVariant.name?.toLowerCase().includes('harian') || originalVariant.duration <= 1;

      let recommendations: Account[] = [];

      // Helper function to check if account is valid based on max 2 extra users limit
      const isAccountValid = (acc: Account) => {
        let totalMaxUsers = 0;
        let totalActiveUsers = 0;
        acc.profile?.forEach(p => {
          totalMaxUsers += p.max_user || 0;
          const activeUsers = p.user?.filter(u => u.status === 'active') || [];
          totalActiveUsers += activeUsers.length;
        });
        return totalActiveUsers < totalMaxUsers + 2;
      };

      if (isDaily) {
        // Menggunakan created_at dari accountUser asal (atau fallback ke Date.now jika null)
        const userCreatedAtTime = accountUser.getDataValue('created_at') || (accountUser as any).createdAt
          ? new Date(accountUser.getDataValue('created_at') || (accountUser as any).createdAt).getTime() 
          : Date.now();

        const accounts = await this.accountRepository.findAll({
          where: {
            id: { [Op.ne]: accountUser.account_id },
            product_variant_id: originalVariant.id, // Tidak boleh lintas varian
            status: { [Op.ne]: 'enable' }, // Tidak muncul jika enable (user kosong)
            batch_start_date: { [Op.lte]: new Date(userCreatedAtTime - 5 * 60 * 60 * 1000) }, // Dipakai minimal 5 jam sebelum transaksi user asal
          },
          include: [
            {
              model: ProductVariant,
              as: 'product_variant',
              include: [{ model: Product, as: 'product' }]
            },
            {
              model: AccountProfile,
              as: 'profile',
              include: [{ model: AccountUser, as: 'user' }]
            },
            { model: Email, as: 'email' }
          ],
          transaction,
          order: [['batch_start_date', 'DESC']],
        });

        const validAccounts = accounts.filter(isAccountValid);
        recommendations = validAccounts.slice(0, 5);
      } else {
        const targetDate = accountUser.expired_at || accountUser.account?.batch_end_date;
        if (!targetDate) {
           throw new BadRequestException('Akun asal tidak memiliki tanggal kedaluwarsa yang valid');
        }

        const accounts = await this.accountRepository.findAll({
          where: {
            id: { [Op.ne]: accountUser.account_id },
            status: { [Op.ne]: 'enable' }, // Tidak muncul jika enable
          },
          include: [
             { 
               model: ProductVariant, 
               as: 'product_variant',
               where: { product_id: originalVariant.product_id },
               include: [{ model: Product, as: 'product' }]
             },
             { model: AccountProfile, as: 'profile', include: [{ model: AccountUser, as: 'user' }] },
             { model: Email, as: 'email' }
          ],
          transaction,
        });

        const validAccounts = accounts.filter(isAccountValid);

        const targetTime = targetDate.getTime();
        const sorted = validAccounts.sort((a, b) => {
           const timeA = a.batch_end_date ? a.batch_end_date.getTime() : 0;
           const timeB = b.batch_end_date ? b.batch_end_date.getTime() : 0;
           return Math.abs(timeA - targetTime) - Math.abs(timeB - targetTime);
        });

        recommendations = sorted.slice(0, 5);
      }

      await transaction.commit();
      return recommendations;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  async getMoveHistory(tenantId: string, accountId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const history = await this.accountUserMoveHistoryRepository.findAll({
        where: {
          [Op.or]: [
            { from_account_id: accountId },
            { to_account_id: accountId }
          ]
        },
        include: [
          { model: AccountUser, as: 'account_user' },
          { model: Account, as: 'from_account', include: [{ model: Email, as: 'email' }] },
          { model: AccountProfile, as: 'from_profile' },
          { model: Account, as: 'to_account', include: [{ model: Email, as: 'email' }] },
          { model: AccountProfile, as: 'to_profile' }
        ],
        order: [['created_at', 'DESC']],
        transaction,
      });

      await transaction.commit();
      return history;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  async getNetflixToken(tenantId: string, accountId: string) {
    const accountTx = await this.postgresProvider.transaction();
    let email = '';
    try {
      await this.postgresProvider.setSchema(tenantId, accountTx);
      const account = await this.accountRepository.findByPk(accountId, {
        include: [{ model: Email, as: 'email' }],
        transaction: accountTx,
      });

      if (!account) {
        throw new NotFoundException('Account not found');
      }

      email = account.email.email;
      await accountTx.commit();
    } catch (error) {
      await accountTx.rollback();
      throw error;
    }

    const emailFileName = email.toLowerCase().replace(/[.@]/g, '_');
    
    // Check if session exists in the database (Read-only, commit early)
    let sessionData: any = null;
    const sessionTx = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, sessionTx);
      const session = await this.accountSessionRepository.findOne({
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
      this.logger.error(`[NetflixTokenDirect] Failed to get session: ${e.message}`, e.stack, 'AccountService');
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

        this.logger.log(`[NetflixTokenDirect] Fetching token directly for ${email} in tenant ${tenantId}`, 'AccountService');
        
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
            this.logger.error(`[NetflixTokenDirect] FTL API Error for ${email}: ${fetchResponse.status} - ${errText}`, '', 'AccountService');
          }
        } catch (fetchErr: any) {
          this.logger.error(`[NetflixTokenDirect] Fetch failed or master schema error: ${fetchErr.message}`, fetchErr.stack, 'AccountService');
        }
      }
    }

    // Fallback: Enqueue async task — returns taskId immediately without blocking
    const taskId = await this.taskQueueService.enqueueNetflixGetToken(tenantId, email);
    return { status: 'processing', taskId };
  }

  async importNetflixCookies(tenantId: string, accountId: string, cookies: any) {
    try {
      const account = await this.findOne(tenantId, accountId);
      if (!account) {
        throw new NotFoundException('Account not found');
      }

      const email = account.email?.email;
      if (!email) {
        throw new Error('Account does not have an email assigned');
      }

      // Also save to database
      const emailFileName = email.toLowerCase().replace(/[.@]/g, '_');
      const transaction = await this.postgresProvider.transaction();
      try {
        await this.postgresProvider.setSchema(tenantId, transaction);
        
        const existing = await this.accountSessionRepository.findOne({
          where: {
            platform: 'netflix',
            identifier: emailFileName,
          },
          transaction,
        });

        let parsedCookies = Array.isArray(cookies) ? cookies : (cookies.cookies || []);
        if (Array.isArray(parsedCookies)) {
          parsedCookies = parsedCookies.map((c: any) => {
            let sameSite = c.sameSite;
            if (typeof sameSite === 'string') {
              const lower = sameSite.toLowerCase();
              if (lower === 'lax') sameSite = 'Lax';
              else if (lower === 'strict') sameSite = 'Strict';
              else if (lower === 'none' || lower === 'no_restriction') sameSite = 'None';
              else sameSite = 'Lax';
            } else if (!sameSite) {
               // Playwright sometimes expects None for cross-site cookies, but Lax is a safe default
               sameSite = 'Lax'; 
            }
            return { ...c, sameSite };
          });
        }
        
        const cookiesToSave = { 
          ...(Array.isArray(cookies) ? {} : cookies), 
          cookies: parsedCookies 
        };

        if (existing) {
          await existing.update({ session_data: cookiesToSave }, { transaction });
        } else {
          await this.accountSessionRepository.create({
            platform: 'netflix',
            identifier: emailFileName,
            session_data: cookiesToSave,
          }, { transaction });
        }
        await transaction.commit();
      } catch (err: any) {
        await transaction.rollback();
        this.logger.error(`Failed to save imported cookies to DB: ${err.message}`, err.stack, 'AccountServiceImportCookies');
      }

      return { success: true, message: 'Cookies berhasil disimpan ke database' };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new Error(`Failed to import Netflix cookies: ${error.message}`);
    }
  }

  async syncCookiesFromBot(tenantId: string, email: string, botName: string, accountId: string) {
    // Deprecated: Bot no longer stores local state. Cookies are always fetched from DB.
    return { success: true, message: 'Sync tidak diperlukan (State tersimpan di Database)' };
  }

  async getMoveHistoryByProduct(tenantId: string, productId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      const history = await this.accountUserMoveHistoryRepository.findAll({
        include: [
          { model: AccountUser, as: 'account_user' },
          { 
            model: Account, 
            as: 'from_account', 
            include: [
              { model: Email, as: 'email' },
              { model: ProductVariant, as: 'product_variant', where: { product_id: productId }, required: true }
            ],
            required: true
          },
          { model: AccountProfile, as: 'from_profile' },
          { model: Account, as: 'to_account', include: [{ model: Email, as: 'email' }] },
          { model: AccountProfile, as: 'to_profile' }
        ],
        order: [['created_at', 'DESC']],
        limit: 100,
        transaction,
      });

      await transaction.commit();
      return history;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}
