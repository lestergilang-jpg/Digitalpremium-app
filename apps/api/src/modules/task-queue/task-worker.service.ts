import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { Op, QueryTypes } from 'sequelize';
import { TASK_QUEUE_REPOSITORY } from 'src/constants/database.const';
import { REDIS_CLIENT } from 'src/constants/provider.const';
import { CONSUMER_GROUP, STREAM_KEY, TASK_REFERENCE_KEY, ZSET_KEY } from 'src/constants/scheduler.const';
import {
  NETFLIX_AUTO_RELOAD,
  NETFLIX_AUTO_UPGRADE,
  NETFLIX_LOGIN_TV,
  NETFLIX_GET_TOKEN,
  NETFLIX_RESET_PASSWORD,
  SUBS_END_NOTIFY,
  UNFREEZE_ACCOUNT,
} from 'src/constants/task.const';
import { TaskQueue } from 'src/database/models/task-queue.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { UnknownTaskError } from 'src/exceptions/unknown-task.error';
import { AppLoggerService } from '../logger/logger.service';
import { TaskHelperService } from './task-helper.service';
import { AccountSubsEndNotifyPayload, AccountUnfreezePayload, NetflixAutoReloadPayload, NetflixAutoUpgradePayload, NetflixResetPasswordPayload } from './types/task-context.type';
import { TaskMessage } from './types/task-message.type';
import { TaskQueueContext } from './types/task-queue-data.type';
import { TaskQueueUpdate } from './types/task-queue-update.type';

export class TaskWorkerService {
  instanceName: string;
  maxAttempt = 3;

  constructor(
    private readonly logger: AppLoggerService,
    private readonly configService: ConfigService,
    private readonly taskHelperService: TaskHelperService,
    private readonly postgresProvider: PostgresProvider,
    @Inject(REDIS_CLIENT) private readonly redisClient: Redis,
    @Inject(TASK_QUEUE_REPOSITORY) private readonly taskQueueRepository: typeof TaskQueue
  ) {
    this.instanceName = configService.get<string>('app.instance_name')!;
  }

  async onModuleInit() {
    try {
      await this.redisClient.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    }
    catch (err) {
      if (!err.message.includes('BUSYGROUP'))
        throw err;
    }

    // 2. Reload semua task QUEUED/DISPATCHED dari DB ke Redis (recovery setelah restart)
    await this.reloadQueuedTasksToRedis();

    // 3. Jalankan loop consumer biasa
    this.consumeTasks();
  }

  /**
   * Recovery mechanism: saat API restart atau secara berkala,
   * Method ini membaca semua task yang belum selesai dari PostgreSQL
   * dan mendaftarkannya kembali ke Redis ZSET agar terjadwal dengan benar.
   * CATATAN: Hanya reload task yang execute_at >= 1 jam yang lalu (buffer),
   * agar task lama yang sudah lewat tidak ikut dieksekusi ulang.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async reloadQueuedTasksToRedis() {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      // Ambil tugas yang belum selesai dari DB:
      // - Task yang BELUM waktunya (future) → harus selalu dimuat agar terjadwal
      // - Task yang baru saja terlewat maks 1 jam → untuk recovery saat VPS restart singkat
      // - Task lama (> 1 jam yang lalu) → TIDAK dimuat agar tidak spam eksekusi massal
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const pendingTasks = await this.taskQueueRepository.findAll({
        where: {
          status: ['QUEUED'],
          execute_at: { [Op.gte]: oneHourAgo },
        },
        transaction,
      });

      if (!pendingTasks.length) {
        this.logger.log('TaskWorker: Tidak ada task pending yang perlu di-reload ke Redis.', 'TaskWorkerInit');
        await transaction.commit();
        return;
      }

      this.logger.log(`TaskWorker: Mereload ${pendingTasks.length} task ke Redis ZSET...`, 'TaskWorkerInit');

      const redisPipeline = this.redisClient.pipeline();
      for (const task of pendingTasks) {
        const executeAt = new Date(task.dataValues.execute_at).getTime();
        redisPipeline.zadd(ZSET_KEY, executeAt, `${TASK_REFERENCE_KEY}:${task.id}`);
      }
      await redisPipeline.exec();

      await transaction.commit();
      this.logger.log(`TaskWorker: Berhasil reload ${pendingTasks.length} task ke Redis.`, 'TaskWorkerInit');
    }
    catch (error) {
      await transaction.rollback();
      this.logger.error(`TaskWorker: Gagal reload task ke Redis: ${error.message}`, error.stack, 'TaskWorkerInit');
    }
  }

  async consumeTasks() {
    while (true) {
      try {
        const response = await this.redisClient.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          this.instanceName,
          'COUNT',
          1,
          'BLOCK',
          5000,
          'STREAMS',
          STREAM_KEY,
          '>' // Baca pesan yang BELUM PERNAH dideliver ke siapapun
        );

        if (response) {
          const [streamData] = response as any;
          const messages = streamData[1];
          if (messages && messages.length > 0) {
            await this.handleMessage(messages);
          }
        }
      }
      catch (error) {
        this.logger.error(`Error consuming stream: ${error.message}`, error.stack, 'ConsumeTask');
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  @Cron('*/1 * * * * *')
  async dispatchReadyTasks() {
    const now = Date.now();

    // Step 1: Ambil task dari ZSET yang sudah waktunya (tapi belum pindah ke Stream)
    const rawMembers = await this.redisClient.zrangebyscore(ZSET_KEY, '-inf', now, 'LIMIT', 0, 50) as string[];
    if (!rawMembers.length) return;

    const taskIds = rawMembers.map(m => m.replace(`${TASK_REFERENCE_KEY}:`, ''));

    // Step 2: Update status DB ke DISPATCHED DULU sebelum pindah ke Stream
    // Ini mencegah race condition di mana task masih QUEUED di DB tapi sudah di Stream
    const transaction = await this.postgresProvider.transaction();
    let successfulTaskIds: string[] = [];
    try {
      await this.postgresProvider.setSchema('master', transaction);
      await this.taskQueueRepository.update(
        { status: 'DISPATCHED' },
        { where: { id: taskIds, status: 'QUEUED' }, transaction },
      );
      // Ambil yang benar-benar berhasil diupdate (masih QUEUED sebelumnya)
      // Cara aman: anggap semua berhasil, karena hanya yang QUEUED yang terupdate
      successfulTaskIds = taskIds;
      await transaction.commit();
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'DispatchTask:DBUpdate');
      await transaction.rollback();
      return; // Jangan lanjut ke Redis jika DB gagal
    }

    // Step 3: Pindahkan dari ZSET ke Stream secara atomik (Lua)
    if (successfulTaskIds.length === 0) return;

    const luaScript = `
      local zsetKey = KEYS[1]
      local streamKey = KEYS[2]
      local streamLimit = ARGV[1]
      local moved = 0

      for i = 2, #ARGV do
        local member = ARGV[i]
        local removed = redis.call('ZREM', zsetKey, member)
        if removed == 1 then
          redis.call('XADD', streamKey, 'MAXLEN', '~', streamLimit, '*', 'taskData', member)
          moved = moved + 1
        end
      end

      return moved
    `;

    try {
      const args: (string | number)[] = [500];
      for (const id of successfulTaskIds) {
        args.push(`${TASK_REFERENCE_KEY}:${id}`);
      }
      await this.redisClient.eval(
        luaScript,
        2,
        ZSET_KEY,
        STREAM_KEY,
        ...args
      );
    }
    catch (error) {
      this.logger.error(error.message, error.stack, 'DispatchTask:RedisStream');
      // Jika Redis gagal, rollback status DB kembali ke QUEUED agar task bisa di-retry
      const rollbackTransaction = await this.postgresProvider.transaction();
      try {
        await this.postgresProvider.setSchema('master', rollbackTransaction);
        await this.taskQueueRepository.update(
          { status: 'QUEUED' },
          { where: { id: successfulTaskIds }, transaction: rollbackTransaction },
        );
        await rollbackTransaction.commit();
      }
      catch (rollbackErr) {
        this.logger.error(`Rollback gagal: ${rollbackErr.message}`, rollbackErr.stack, 'DispatchTask:Rollback');
        await rollbackTransaction.rollback();
      }
    }
  }

  /**
   * Auto-cleanup: Setiap jam, hapus task QUEUED/DISPATCHED yang sudah lebih dari 5 jam
   * melewati waktu execute_at-nya. Task seperti ini sudah pasti tidak akan tereksekusi
   * (VPS mati terlalu lama) sehingga aman untuk dihapus agar DB tidak menumpuk.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOverdueTasks() {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const overdueTasks = await this.taskQueueRepository.findAll({
        where: {
          status: ['QUEUED', 'DISPATCHED'],
          execute_at: { [Op.lt]: fiveHoursAgo },
        },
        transaction,
      });

      if (!overdueTasks.length) {
        await transaction.commit();
        return;
      }

      const overdueIds = overdueTasks.map(t => t.id);

      // Hapus dari DB
      await this.taskQueueRepository.destroy({
        where: { id: overdueIds },
        transaction,
      });

      await transaction.commit();

      // Hapus dari Redis ZSET
      const redisPipeline = this.redisClient.pipeline();
      for (const id of overdueIds) {
        redisPipeline.zrem(ZSET_KEY, `${TASK_REFERENCE_KEY}:${id}`);
      }
      await redisPipeline.exec();

      this.logger.warn(
        `Auto-Cleanup: Menghapus ${overdueIds.length} task yang sudah lewat lebih dari 5 jam.`,
        'TaskWorkerCleanup',
      );
    }
    catch (error) {
      await transaction.rollback();
      this.logger.error(`Auto-Cleanup gagal: ${error.message}`, error.stack, 'TaskWorkerCleanup');
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverPendingTasks() {
    const minIdleTime = 60000; // 60 detik. Jika pesan pending > 60s, anggap consumer mati/gagal.
    const count = 10; // Ambil max 10 task stuck sekaligus

    try {
      // XAUTOCLAIM: Otomatis claim pesan dari consumer manapun yang idle
      // Format return ioredis XAUTOCLAIM: [cursor, [messages]]
      const response = await this.redisClient.xautoclaim(
        STREAM_KEY,
        CONSUMER_GROUP,
        this.instanceName,
        minIdleTime,
        '0-0',
        'COUNT',
        count
      );

      const messages = response[1] as any;

      if (messages && messages.length > 0) {
        this.logger.warn(`Recovered ${messages.length} stuck tasks!`);
        await this.handleMessage(messages);
      }
    }
    catch (error) {
      this.logger.error(`Error recovering tasks: ${error.message}`, error.stack, 'RecoverPendingTask');
    }
  }

  private async handleMessage(messages: any[]) {
    const taskMessages: TaskMessage[] = [];

    // 1. Parsing Pesan
    for (const message of messages) {
      const [id, fields] = message;

      const taskDataIndex = fields.indexOf('taskData');
      if (taskDataIndex === -1) {
        // Jika format salah, ACK agar tidak stuck
        await this.redisClient.xack(STREAM_KEY, CONSUMER_GROUP, id);
        continue;
      }

      const taskData = fields[taskDataIndex + 1] as string;
      const taskId = taskData.replace(`${TASK_REFERENCE_KEY}:`, '');
      taskMessages.push({
        messageId: id,
        taskId,
      });
    }

    if (taskMessages.length === 0)
      return;

    // 2. Query ke DB secara Batch
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      const taskIds = taskMessages.map(jm => jm.taskId);
      const taskQueue = await this.taskQueueRepository.findAll({
        where: { id: taskIds },
        transaction,
      });

      if (taskQueue.length) {
        for (const tq of taskQueue) {
          for (const tm of taskMessages) {
            if (tq.id === tm.taskId) {
              const payload = JSON.parse(tq.dataValues.payload);

              let attempt = 0;
              if (typeof (tq.dataValues.attempt) === 'number') {
                attempt = tq.dataValues.attempt + 1;
              }

              tm.taskData = {
                id: tq.id,
                context: tq.dataValues.context as TaskQueueContext,
                tenant_id: tq.dataValues.tenant_id,
                payload,
              };
              tm.attempt = attempt;
            }
          }
        }
      }

      await transaction.commit();
    }
    catch {
      await transaction.rollback();
    }

    // 3. Eksekusi Task dan ACK
    const taskQueueUpdates: TaskQueueUpdate[] = [];
    for (const tm of taskMessages) {
      if (!tm.taskData) {
        // Task not found in DB (probably deleted by cleanup), ACK to remove from stream
        await this.redisClient.xack(STREAM_KEY, CONSUMER_GROUP, tm.messageId);
        continue;
      }

      try {
        if (tm.taskData.context === SUBS_END_NOTIFY) {
          await this.taskHelperService.accountSubsEndNotify(tm.taskData.tenant_id, {
            ...(tm.taskData.payload as AccountSubsEndNotifyPayload),
            tenant_id: tm.taskData.tenant_id,
          });
        }
        else if (tm.taskData.context === NETFLIX_RESET_PASSWORD) {
          await this.taskHelperService.netflixResetPassword(tm.taskData.id, tm.taskData.tenant_id, tm.taskData.payload as NetflixResetPasswordPayload);
        }
        else if (tm.taskData.context === NETFLIX_AUTO_RELOAD) {
          await this.taskHelperService.netflixAutoReload(tm.taskData.id, tm.taskData.tenant_id, tm.taskData.payload as NetflixAutoReloadPayload);
        }
        else if (tm.taskData.context === NETFLIX_AUTO_UPGRADE) {
          await this.taskHelperService.netflixAutoUpgrade(tm.taskData.id, tm.taskData.tenant_id, tm.taskData.payload as NetflixAutoUpgradePayload);
        }
        else if (tm.taskData.context === NETFLIX_LOGIN_TV) {
          await this.taskHelperService.netflixLoginTv(tm.taskData.id, tm.taskData.tenant_id, tm.taskData.payload as any);
        }
        else if (tm.taskData.context === NETFLIX_GET_TOKEN) {
          await this.taskHelperService.netflixGetToken(tm.taskData.id, tm.taskData.tenant_id, tm.taskData.payload as { email: string; target_bot?: string });
        }
        else if (tm.taskData.context === UNFREEZE_ACCOUNT) {
          await this.taskHelperService.unfreezeAccount(tm.taskData.tenant_id, tm.taskData.payload as AccountUnfreezePayload);
        }
        else if (tm.taskData.context === 'SEND_WA_MESSAGE') {
          const waPayload = typeof tm.taskData.payload === 'string' 
            ? JSON.parse(tm.taskData.payload) 
            : tm.taskData.payload;
          await this.taskHelperService.sendWaMessage(tm.taskData.id, tm.taskData.tenant_id, waPayload);
        }
        else {
          throw new UnknownTaskError(`Unknown Task: ${tm.taskData.context}`);
        }

        await this.redisClient.xack(STREAM_KEY, CONSUMER_GROUP, tm.messageId);

        const isAsyncNetflixTask = [
          NETFLIX_RESET_PASSWORD,
          NETFLIX_AUTO_RELOAD,
          NETFLIX_AUTO_UPGRADE,
          NETFLIX_LOGIN_TV,
          NETFLIX_GET_TOKEN,
        ].includes(tm.taskData.context);

        taskQueueUpdates.push({
          id: tm.taskId,
          status: isAsyncNetflixTask ? 'DISPATCHED' : 'COMPLETED',
          attempt: tm.attempt || 0,
        });
      }
      catch (error) {
        this.logger.error(`Task ${tm.taskId} Failed. ${error.message}`, error.stack, 'TaskWorker');

        const isUnknownError = error instanceof UnknownTaskError;
        const isMaxAttemptReached = tm.attempt! > this.maxAttempt;

        if (isUnknownError || isMaxAttemptReached) {
          await this.redisClient.xack(STREAM_KEY, CONSUMER_GROUP, tm.messageId);
          taskQueueUpdates.push({
            id: tm.taskId,
            status: 'FAILED',
            attempt: isUnknownError ? tm.attempt! : this.maxAttempt,
            error_message: (error as Error).message,
          });
        }
        else {
          taskQueueUpdates.push({
            id: tm.taskId,
            status: 'DISPATCHED',
            attempt: tm.attempt!,
          });
        }
      }
    }

    if (taskQueueUpdates.length) {
      const taskQueueUpdateQuery = taskQueueUpdates.map((tqu) => {
        const safeErrorMessage = tqu.error_message ? `'${tqu.error_message}'` : 'NULL';
        return `(${tqu.id}, ${tqu.attempt}, '${tqu.status}', ${safeErrorMessage})`;
      }).join(', ');
      const transaction = await this.postgresProvider.transaction();
      try {
        await this.postgresProvider.setSchema('master', transaction);
        const query = `
          UPDATE task_queue AS t
          SET 
              attempt = v.attempt::integer,
              status = v.status::varchar,
              error_message = v.error_message::text,
              updated_at = NOW()
          FROM (VALUES ${taskQueueUpdateQuery}) AS v(id, attempt, status, error_message)
          WHERE t.id = v.id::bigint;
        `;

        await this.postgresProvider.rawQuery(query, {
          type: QueryTypes.UPDATE,
          transaction,
        });
        await transaction.commit();
      }
      catch (error) {
        this.logger.error(`Error update task status: ${error.message}`, error.stack, 'TaskWorker');
        await transaction.rollback();
      }
    }
  }
}
