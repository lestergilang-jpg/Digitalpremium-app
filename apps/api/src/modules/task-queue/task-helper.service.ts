import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ACCOUNT_REPOSITORY, PRODUCT_VARIANT_REPOSITORY } from 'src/constants/database.const';
import { NETFLIX_REQ_RESET_PASSWORD } from 'src/constants/email-subject.const';
import { Account } from 'src/database/models/account.model';
import { Email } from 'src/database/models/email.model';
import { ProductVariant } from 'src/database/models/product-variant.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { AppLoggerService } from '../logger/logger.service';
import { SyslogService } from '../logger/syslog.service';
import { SocketGateway } from '../socket/socket.gateway';
import { EmailParser } from '../utility/email-parser.provider';
import { AccountSubsEndNotifyPayload, AccountUnfreezePayload, NetflixAutoReloadPayload, NetflixAutoUpgradePayload, NetflixResetPasswordPayload } from './types/task-context.type';

@Injectable()
export class TaskHelperService {
  constructor(
    private readonly logger: AppLoggerService,
    private readonly emailParser: EmailParser,
    private readonly sysLogService: SyslogService,
    private readonly socketGateway: SocketGateway,
    private readonly postgresProvider: PostgresProvider,
    @Inject(ACCOUNT_REPOSITORY) private readonly accountRepository: typeof Account,
    @Inject(PRODUCT_VARIANT_REPOSITORY) private readonly productVariantRepository: typeof ProductVariant,
  ) {}

  async unfreezeAccount(tenantId: string, payload: AccountUnfreezePayload) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);
      const account = await this.accountRepository.findOne({
        where: { id: payload.accountId },
        transaction,
      });
      if (!account)
        return;
      await account.update({ freeze_until: null }, { transaction });
      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async accountSubsEndNotify(tenantId: string, payload: AccountSubsEndNotifyPayload) {
    this.sysLogService.logToDb(tenantId, { level: 'REMINDER', context: 'AccountSubsEnd', message: payload.message });
  }

  async netflixResetPassword(taskId: string, tenantId: string, payload: NetflixResetPasswordPayload) {
    const transaction = await this.postgresProvider.transaction();
    let account: Account | null = null;
    try {
      await this.postgresProvider.setSchema(tenantId, transaction);

      // Fetch akun terkini untuk mendapatkan password & variant_name yang up-to-date
      // (payload di task queue mungkin stale jika varian berubah setelah task didaftarkan)
      account = await this.accountRepository.findOne({
        where: { id: payload.accountId },
        include: [
          {
            model: Email,
            as: 'email',
            required: true,
          },
          {
            model: ProductVariant,
            as: 'product_variant',
          },
        ],
        transaction,
      });

      if (!account) {
        throw new NotFoundException(`Account with email: ${payload.email} not found`);
      }
      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      this.logger.error(error.message, error.stack, 'TaskProcessorNetflixResetPassword');
      throw error;
    }

    try {
      // Enrich payload dengan data terkini dari DB
      const enrichedPayload: NetflixResetPasswordPayload = {
        ...payload,
        password: account.account_password,
        variant_name: account.product_variant?.name || payload.variant_name,
        subscription_expiry: account.subscription_expiry?.toISOString() || payload.subscription_expiry,
      };

      this.logger.log(
        `[NetflixReset] Dispatch task ${taskId} | email: ${payload.email} | targetBot: ${payload.target_bot}`,
        'TaskHelperService',
      );

      const clientId = await this.socketGateway.dispatchTask(taskId, tenantId, {
        module: 'netflix',
        type: 'resetPassword',
        payload: enrichedPayload,
      }, payload.target_bot);

      if (!clientId) {
        throw new Error('No bot available to handle the task');
      }

      const eventName = `${this.emailParser.sanitizeEmail(payload.email)}:${NETFLIX_REQ_RESET_PASSWORD}`;
      this.socketGateway.subscribeClientToEvent(clientId, eventName);
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'TaskProcessorNetflixResetPassword');
      throw error;
    }
  }

  async netflixAutoReload(taskId: string, tenantId: string, payload: NetflixAutoReloadPayload) {
    try {
      // Dispatch task ke bot via socket
      const clientId = await this.socketGateway.dispatchTask(taskId, tenantId, {
        module: 'netflix',
        type: 'autoReload',
        payload,
      }, payload.target_bot);

      if (!clientId) {
        throw new Error('No bot available to handle the task');
      }

      // Subscribe bot ke event konfirmasi top-up dari dashboard
      const topupEventName = `${payload.accountId}:NETFLIX_TOPUP_CONFIRM`;
      this.socketGateway.subscribeClientToEvent(clientId, topupEventName);
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'TaskProcessorNetflixAutoReload');
      throw error;
    }
  }

  async netflixAutoUpgrade(taskId: string, tenantId: string, payload: NetflixAutoUpgradePayload) {
    try {
      // Dispatch task ke bot via socket dengan method name 'autoUpgradePlan'
      const clientId = await this.socketGateway.dispatchTask(taskId, tenantId, {
        module: 'netflix',
        type: 'autoUpgradePlan',
        payload,
      }, payload.target_bot);

      if (!clientId) {
        throw new Error('No bot available to handle the task');
      }
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'TaskProcessorNetflixAutoUpgrade');
      throw error;
    }
  }

  async netflixLoginTv(taskId: string, tenantId: string, payload: any) {
    try {
      const clientId = await this.socketGateway.dispatchTask(taskId, tenantId, {
        module: 'netflix',
        type: 'loginTvFlow',
        payload,
      }, payload.target_bot);

      if (!clientId) {
        throw new Error('No bot available to handle the task');
      }

      // Subscribe bot to the email reset link event (since it uses loginhelp flow)
      const eventName = `${this.emailParser.sanitizeEmail(payload.email)}:${NETFLIX_REQ_RESET_PASSWORD}`;
      this.socketGateway.subscribeClientToEvent(clientId, eventName);
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'TaskProcessorNetflixLoginTv');
      throw error;
    }
  }

  async sendWaMessage(taskId: string, tenantId: string, payload: any) {
    try {
      const clientId = await this.socketGateway.dispatchTask(taskId, tenantId, {
        module: 'whatsapp',
        type: 'send_wa_message',
        payload,
      }, payload.target_bot);

      if (!clientId) {
        throw new Error('No bot available to handle the task');
      }
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'TaskProcessorSendWaMessage');
      throw error;
    }
  }

  async netflixGetToken(taskId: string, tenantId: string, payload: { email: string; target_bot?: string }) {
    try {
      const clientId = await this.socketGateway.dispatchTask(taskId, tenantId, {
        module: 'netflix',
        type: 'getToken',
        payload,
      }, payload.target_bot);

      if (!clientId) {
        throw new Error('No bot available to handle the task');
      }
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'TaskProcessorNetflixGetToken');
      throw error;
    }
  }
}
