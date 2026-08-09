import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { Op, WhereOptions } from 'sequelize';
import { TASK_QUEUE_REPOSITORY } from 'src/constants/database.const';
import { REDIS_CLIENT } from 'src/constants/provider.const';
import { STREAM_KEY, TASK_REFERENCE_KEY, ZSET_KEY } from 'src/constants/scheduler.const';
import { TaskQueue } from 'src/database/models/task-queue.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { PaginationProvider } from '../utility/pagination.provider';
import { SnowflakeIdProvider } from '../utility/snowflake-id.provider';
import { BaseGetAllUrlQuery } from '../utility/types/base-get-all-url-query.type';
import { UpsertTaskQueueDto } from './dto/upsert-task-queue.dto';
import { ITaskQueueGetFilter } from './filter/task-queue-get.filter';

@Injectable()
export class TaskQueueService {
  constructor(
    private readonly paginationProvider: PaginationProvider,
    private readonly snowflakeIdProvider: SnowflakeIdProvider,
    private readonly postgresProvider: PostgresProvider,
    @Inject(REDIS_CLIENT) private readonly redisClient: Redis,
    @Inject(TASK_QUEUE_REPOSITORY)
    private readonly taskQueueRepository: typeof TaskQueue,
  ) {}

  async findAll(pagination?: BaseGetAllUrlQuery, filter?: ITaskQueueGetFilter) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const { limit, offset, order }
        = this.paginationProvider.generatePaginationQuery(pagination);

      const whereOptions: WhereOptions = {};
      if (filter?.id) {
        whereOptions.id = filter.id;
      }
      if (filter?.type) {
        whereOptions.type = filter.type;
      }
      if (filter?.status) {
        whereOptions.status = filter.status;
      }
      if (filter?.tenant_id) {
        whereOptions.tenant_id = filter.tenant_id;
      }

      const taskQueues = await this.taskQueueRepository.findAndCountAll({
        where: whereOptions,
        order,
        limit,
        offset,
        transaction,
      });

      await transaction.commit();
      return this.paginationProvider.generatePaginationResponse(
        taskQueues.rows,
        taskQueues.count,
        pagination,
      );
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async findOne(taskQueueId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const taskQueue = await this.taskQueueRepository.findOne({
        where: { id: taskQueueId },
        transaction,
      });

      if (!taskQueue) {
        throw new NotFoundException(
          `taskQueue dengan id: ${taskQueueId} tidak ditemukan`,
        );
      }

      await transaction.commit();
      return taskQueue;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async upsert(upsertTaskQueueDto: UpsertTaskQueueDto[]) {
    const redisPipeline = this.redisClient.pipeline();
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      for (const data of upsertTaskQueueDto) {
        let taskQueue = await this.taskQueueRepository.findOne({
          where: {
            tenant_id: data.tenant_id,
            subject_id: data.subject_id,
            context: data.context,
            status: { [Op.notIn]: ['COMPLETED', 'FAILED'] },
          },
          transaction,
        });

        if (taskQueue) {
          // Hapus entry lama dari Redis ZSET sebelum update,
          // agar tidak ada entry stale yang bisa di-dispatch ulang ke bot yang salah
          redisPipeline.zrem(ZSET_KEY, `${TASK_REFERENCE_KEY}:${taskQueue.id}`);
          await taskQueue.update({ ...data, status: 'QUEUED' }, { transaction });
        }
        else {
          const id = this.snowflakeIdProvider.generateId();
          taskQueue = await this.taskQueueRepository.create(
            {
              id,
              attempt: 0,
              ...data,
            },
            { transaction }
          );
        }

        const executeAt = new Date(taskQueue.dataValues.execute_at).getTime();
        redisPipeline.zadd(ZSET_KEY, executeAt, `${TASK_REFERENCE_KEY}:${taskQueue.id}`);
      }

      await redisPipeline.exec();
      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async remove(taskQueueId: string) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const taskQueue = await this.taskQueueRepository.findOne({
        where: { id: taskQueueId },
        transaction,
      });

      if (!taskQueue) {
        throw new NotFoundException(
          `taskQueue dengan id: ${taskQueueId} tidak ditemukan`,
        );
      }

      await taskQueue.destroy({ transaction });
      await this.redisClient.zrem(ZSET_KEY, `${TASK_REFERENCE_KEY}:${taskQueue.id}`);
      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async removeByAccount(
    tenantId: string,
    accountId: string | string[],
    contexts: string[],
  ) {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const taskQueue = await this.taskQueueRepository.findAll({
        where: {
          tenant_id: tenantId,
          subject_id: accountId,
          context: contexts,
        },
        transaction,
      });

      if (!taskQueue.length) {
        await transaction.commit();
        return;
      }

      const taskQueueIds = taskQueue.map(t => t.id);
      await this.taskQueueRepository.destroy({
        where: { id: taskQueueIds },
        transaction,
      });

      const redisPipeline = this.redisClient.pipeline();
      for (const id of taskQueueIds) {
        redisPipeline.zrem(ZSET_KEY, `${TASK_REFERENCE_KEY}:${id}`);
      }
      await redisPipeline.exec();

      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async deleteExpiredTasks() {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);

      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const expiredTasks = await this.taskQueueRepository.findAll({
        where: {
          status: ['QUEUED', 'DISPATCHED'],
          execute_at: { [Op.lt]: fiveHoursAgo },
        },
        transaction,
      });

      if (!expiredTasks.length) {
        await transaction.commit();
        return;
      }

      const taskQueueIds = expiredTasks.map(t => t.id);
      await this.taskQueueRepository.destroy({
        where: { id: taskQueueIds },
        transaction,
      });

      const redisPipeline = this.redisClient.pipeline();
      for (const id of taskQueueIds) {
        redisPipeline.zrem(ZSET_KEY, `${TASK_REFERENCE_KEY}:${id}`);
      }
      await redisPipeline.exec();

      await transaction.commit();
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Enqueue a NETFLIX_GET_TOKEN task and return the taskId immediately.
   * The actual bot work happens asynchronously; the result is pushed via WebSocket event.
   */
  async enqueueNetflixGetToken(tenantId: string, email: string, targetBot?: string): Promise<string> {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      const taskId = this.snowflakeIdProvider.generateId();
      await this.taskQueueRepository.create(
        {
          id: taskId,
          tenant_id: tenantId,
          subject_id: email,
          context: 'NETFLIX_GET_TOKEN',
          status: 'DISPATCHED',
          attempt: 0,
          execute_at: new Date(),
          payload: JSON.stringify({ email, target_bot: targetBot }),
        },
        { transaction },
      );
      // Directly add to Redis stream bypassing ZSET delay
      await this.redisClient.xadd(STREAM_KEY, '*', 'taskData', `${TASK_REFERENCE_KEY}:${taskId}`);
      await transaction.commit();
      return taskId;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async enqueueImmediate(
    tenantId: string,
    subjectId: string,
    context: string,
    payload: any,
  ): Promise<string> {
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      const taskId = this.snowflakeIdProvider.generateId();
      await this.taskQueueRepository.create(
        {
          id: taskId,
          tenant_id: tenantId,
          subject_id: subjectId,
          context,
          status: 'DISPATCHED',
          attempt: 0,
          execute_at: new Date(),
          payload: JSON.stringify(payload),
        },
        { transaction },
      );
      // Directly add to Redis stream bypassing ZSET delay
      await this.redisClient.xadd(STREAM_KEY, '*', 'taskData', `${TASK_REFERENCE_KEY}:${taskId}`);
      await transaction.commit();
      return taskId;
    }
    catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

