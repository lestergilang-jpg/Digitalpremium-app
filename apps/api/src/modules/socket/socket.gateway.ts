import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SHORT_URL_REPOSITORY, TASK_QUEUE_REPOSITORY, TENANT_REPOSITORY } from 'src/constants/database.const';
import { ShortUrl } from 'src/database/models/short-url.model';
import { TaskQueue } from 'src/database/models/task-queue.model';
import { Tenant } from 'src/database/models/tenant.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { IAccessTokenPayload } from 'src/types/access-token.type';
import { AppLoggerService } from '../logger/logger.service';
import { TokenProvider } from '../utility/token.provider';
import { ConnectionSubscribeEventData } from './types/connection-event.type';
import { ConnectionTaskAcceptData, ConnectionTaskDoneData, ConnectionTaskRejectData, DispatchTaskData } from './types/connection-task.type';
import { SocketAuthContext, SocketConnection, SocketConnectionType } from './types/socket-connection.type';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  private connections: Map<string, SocketConnection> = new Map();
  private events: Map<string, Set<string>> = new Map();

  constructor(
    private readonly logger: AppLoggerService,
    private readonly tokenProvider: TokenProvider,
    private readonly configService: ConfigService,
    private readonly postgresProvider: PostgresProvider,
    @Inject(TENANT_REPOSITORY) private readonly tenantRepository: typeof Tenant,
    @Inject(TASK_QUEUE_REPOSITORY) private readonly taskQueueRepository: typeof TaskQueue,
    @Inject(SHORT_URL_REPOSITORY) private readonly shortUrlRepository: typeof ShortUrl,
  ) {}

  afterInit(server: Server) {
    server.use(async (socket, next) => {
      const conn = this.connections.get(socket.id);
      if (conn) {
        return next();
      }

      const token = socket.handshake.auth.token;
      const name = socket.handshake.query.connection_name as string;
      const type = socket.handshake.query.connection_type as SocketConnectionType;
      const is_primary = socket.handshake.query.is_primary === 'true';

      if (!token && !name && !type) {
        const err = new Error('ValidationError');
        (err as any).data = {
          type: 'ValidationError',
          message: 'Auth token & query param missing',
        };
        return next(err);
      }

      const tokenPayload = this.tokenProvider.decodeJwt<IAccessTokenPayload>(token);

      let tenant: Tenant | null = null;
      const transaction = await this.postgresProvider.transaction();
      try {
        await this.postgresProvider.setSchema('master', transaction);
        tenant = await this.tenantRepository.findOne({
          where: { id: tokenPayload.tenant_id },
          transaction,
        });
        if (!tenant) {
          throw new Error('Tenant not found in database!');
        }
        await transaction.commit();
      }
      catch (error) {
        this.logger.error(
          `Get Tenant from DB Error: ${(error as Error).message}`,
          (error as Error).stack,
          'WebsocketConnect',
        );
        await transaction.rollback();
        const err = new Error('InternalServerError');
        (err as any).data = {
          type: 'InternalServerError',
          message: 'Something wrong in server',
        };
        return next(err);
      }

      try {
        const payload = await this.tokenProvider.verifyJwt<IAccessTokenPayload>(
          this.configService.get<string>('token.secret')!,
          token,
        );

        socket.data.authContext = {
          tenant_id: payload.tenant_id,
          name,
          type,
          is_primary,
        };

        return next();
      }
      catch {
        const err = new Error('InvalidTokenError');
        (err as any).data = {
          type: 'InvalidTokenError',
          message: 'Token invalid',
        };
        return next(err);
      }
    });
  }

  async handleConnection(client: Socket) {
    const authContext = client.data.authContext as SocketAuthContext;

    this.connections.set(client.id, {
      socket: client,
      name: authContext.name,
      type: authContext.type,
      tenant_id: authContext.tenant_id,
      inflight: 0,
      connectedAt: Date.now(),
      is_primary: authContext.is_primary,
    });
  }

  handleDisconnect(client: Socket) {
    this.connections.delete(client.id);
  }

  @SubscribeMessage('task-accept')
  async handleTaskAccepted(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConnectionTaskAcceptData
  ) {
    // No-op: status DISPATCHED dan inflight count sudah di-handle langsung di SocketGateway.dispatchTask
  }

  @SubscribeMessage('task-reject')
  async handleTaskRejected(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConnectionTaskRejectData
  ) {
    const conn = this.connections.get(client.id);
    if (!conn) {
      return;
    }

    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      await this.taskQueueRepository.update(
        { status: 'FAILED', error_message: data.message },
        {
          where: {
            id: data.taskId,
          },
          transaction,
        }
      );
      await transaction.commit();
      conn.inflight -= conn.inflight === 0 ? 0 : 1;
    }
    catch (e) {
      this.logger.error(
        `Update task ${data.taskId} status reject error`,
        (e as Error).stack,
        'TaskReject'
      );
      await transaction.rollback();
    }
  }

  @SubscribeMessage('task-done')
  async handleTaskDone(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConnectionTaskDoneData
  ) {
    const conn = this.connections.get(client.id);
    if (!conn) {
      return;
    }

    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      
      const task = await this.taskQueueRepository.findByPk(data.taskId, { transaction });
      if (!task) {
        throw new Error(`Task with id ${data.taskId} not found`);
      }

      let enrichedPayload = data.payload;

      if (task.context === 'NETFLIX_GET_TOKEN' && data.status === 'COMPLETED') {
        const token = data.payload?.token;
        if (!token) {
          throw new Error('No token returned from bot for NETFLIX_GET_TOKEN task');
        }

        const tenantId = task.tenant_id;
        const pcUrl = `https://www.netflix.com/login?nftoken=${token}`;
        const mobileUrl = `https://www.netflix.com/unsupported?nftoken=${token}`;
        const tvUrl = `https://www.netflix.com/tv9?nftoken=${token}`;
        const generalUrl = `https://www.netflix.com/account?nftoken=${token}`;

        const generateShort = async (url: string) => {
          const code = crypto.randomBytes(4).toString('hex');
          const expiresAt = new Date();
          expiresAt.setHours(expiresAt.getHours() + 24);
          await this.shortUrlRepository.create(
            { id: code, target_url: url, expires_at: expiresAt },
            { transaction }
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

        const tenant = await this.tenantRepository.findByPk(tenantId, { transaction });
        if (tenant && tenant.custom_domain) {
          baseUrl = `https://${tenant.custom_domain.toLowerCase()}`;
        }

        enrichedPayload = {
          token,
          pcLink: `${baseUrl}/l/${pcCode}`,
          mobileLink: `${baseUrl}/l/${mobileCode}`,
          tvLink: `${baseUrl}/l/${tvCode}`,
          generalLink: `${baseUrl}/l/${generalCode}`
        };
      }

      await this.taskQueueRepository.update(
        { 
          status: data.status, 
          error_message: data.message,
          payload: data.status === 'COMPLETED' && enrichedPayload ? JSON.stringify(enrichedPayload) : task.payload
        },
        {
          where: {
            id: data.taskId,
          },
          transaction,
        }
      );
      await transaction.commit();
      conn.inflight -= conn.inflight === 0 ? 0 : 1;

      // Emit event ke frontend (contoh eventName: task:TASK_ID:done)
      this.sendEvent(`task:${data.taskId}:done`, {
        status: data.status,
        message: data.message,
        payload: enrichedPayload, 
      });
    }
    catch (e) {
      this.logger.error(
        `Update task ${data.taskId} status done error`,
        (e as Error).stack,
        'TaskDone'
      );
      await transaction.rollback();
    }
  }

  @SubscribeMessage('subscribe-event')
  async handleEventSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConnectionSubscribeEventData
  ) {
    if (!data.eventName) {
      client.emit('subscribe-event-error', {
        message: 'eventName in body required',
      });
      return;
    }
    return this.subscribeClientToEvent(client.id, data.eventName);
  }

  @SubscribeMessage('unsubscribe-event')
  async handleEventUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ConnectionSubscribeEventData
  ) {
    if (!data.eventName) {
      client.emit('unsubscribe-event-error', {
        message: 'eventName in body required',
      });
      return;
    }
    return this.unsubscribeClientToEvent(client.id, data.eventName);
  }

  getActiveBots(tenantId: string): { name: string; is_primary: boolean }[] {
    return Array.from(this.connections.values())
      .filter(c => c.tenant_id === tenantId && c.type === 'BOT')
      .map(c => ({ name: c.name, is_primary: c.is_primary ?? false }));
  }

  async getNetflixTokenFromBot(tenantId: string, email: string): Promise<string> {
    // Try to find primary bot first, if not find any bot
    let availableBot = Array.from(this.connections.values())
      .find(c => c.tenant_id === tenantId && c.type === 'BOT' && c.is_primary);
      
    if (!availableBot) {
      availableBot = Array.from(this.connections.values())
        .find(c => c.tenant_id === tenantId && c.type === 'BOT');
    }

    if (!availableBot) {
      throw new Error('Tidak ada bot yang aktif (online) saat ini.');
    }

    return new Promise((resolve, reject) => {
      // Use socket timeout of 10s
      availableBot.socket.timeout(10000).emit('get_netflix_token_link', { email }, (err: any, response: any) => {
        if (err) {
          reject(new Error('Bot tidak merespons dalam 10 detik (Timeout).'));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else if (response?.token) {
          resolve(response.token);
        } else {
          reject(new Error('Respon tidak valid dari bot.'));
        }
      });
    });
  }

  async importNetflixCookiesToBot(tenantId: string, email: string, cookies: any): Promise<void> {
    let availableBot = Array.from(this.connections.values())
      .find(c => c.tenant_id === tenantId && c.type === 'BOT' && c.is_primary);
      
    if (!availableBot) {
      availableBot = Array.from(this.connections.values())
        .find(c => c.tenant_id === tenantId && c.type === 'BOT');
    }

    if (!availableBot) {
      throw new Error('Tidak ada bot yang aktif (online) saat ini.');
    }

    return new Promise((resolve, reject) => {
      availableBot.socket.timeout(10000).emit('import_netflix_cookies', { email, cookies }, (err: any, response: any) => {
        if (err) {
          reject(new Error('Bot tidak merespons dalam 10 detik (Timeout).'));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve();
        }
      });
    });
  }

  async dispatchTask(
    taskId: string,
    tenantId: string,
    dispatchTaskData?: DispatchTaskData,
    targetBotName?: string
  ) {
    this.logger.log(
      `[SocketGateway] dispatchTask ${taskId} | targetBotName: ${targetBotName}`,
      'SocketGateway',
    );
    let availableBot: SocketConnection | undefined;

    if (targetBotName) {
      availableBot = Array.from(this.connections.values()).find(
        c => c.tenant_id === tenantId && c.type === 'BOT' && c.name === targetBotName
      );
      
      // Jika bot target ditentukan tetapi offline, JANGAN fallback ke bot lain
      if (!availableBot) {
        this.logger.warn(`Target bot '${targetBotName}' is offline. Task ${taskId} will not be dispatched.`);
        const transaction = await this.postgresProvider.transaction();
        try {
          await this.postgresProvider.setSchema('master', transaction);
          await this.taskQueueRepository.update(
            {
              status: 'FAILED',
              error_message: `target bot '${targetBotName}' is offline`,
            },
            { where: { id: taskId }, transaction },
          );
          await transaction.commit();
        }
        catch {
          await transaction.rollback();
        }
        return undefined;
      }
    } else {
      // Hanya jika tidak ada target_bot, cari bot available (fallback/default ke Lenovo)
      availableBot = this.getAvailableBot(tenantId);
    }

    if (!availableBot) {
      // Jangan langsung mark FAILED — throw error agar task-worker bisa retry
      throw new Error('No bot available to handle the task');
    }


    availableBot.socket.emit('task-dispatch', { taskId, ...dispatchTaskData });

    // Langsung update status ke DISPATCHED di DB agar tidak di-dispatch ulang oleh scheduler
    const transaction = await this.postgresProvider.transaction();
    try {
      await this.postgresProvider.setSchema('master', transaction);
      await this.taskQueueRepository.update(
        { status: 'DISPATCHED' },
        { where: { id: taskId }, transaction }
      );
      await transaction.commit();
      availableBot.inflight += 1;
    }
    catch (e) {
      this.logger.error(
        `Directly update task ${taskId} to DISPATCHED error: ${e.message}`,
        (e as Error).stack,
        'SocketGatewayDispatch'
      );
      await transaction.rollback();
    }

    return availableBot.socket.id;
  }

  async sendEvent(eventName: string, payload: any) {
    const event = this.events.get(eventName);
    if (!event) {
      return;
    }

    event.forEach((clientId) => {
      const conn = this.connections.get(clientId);
      if (!conn) {
        return;
      }

      conn.socket.emit('event', { eventName, payload });
    });
  }

  @SubscribeMessage('bot-awaiting-tv-pin')
  handleBotAwaitingTvPin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; accountId: string }
  ) {
    const conn = this.connections.get(client.id);
    if (!conn || conn.type !== 'BOT')
      return;

    // Forward to all dashboard clients of the same tenant
    for (const c of this.connections.values()) {
      if (c.tenant_id === conn.tenant_id && c.type === 'DASHBOARD') {
        c.socket.emit('event', {
          eventName: 'awaiting-tv-pin',
          payload: {
            taskId: data.taskId,
            accountId: data.accountId,
            botSocketId: client.id,
          },
        });
      }
    }
  }

  @SubscribeMessage('bot-tv-pin-error')
  handleBotTvPinError(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; message: string }
  ) {
    const conn = this.connections.get(client.id);
    if (!conn || conn.type !== 'BOT')
      return;

    for (const c of this.connections.values()) {
      if (c.tenant_id === conn.tenant_id && c.type === 'DASHBOARD') {
        c.socket.emit('event', {
          eventName: 'bot-tv-pin-error',
          payload: { taskId: data.taskId, message: data.message },
        });
      }
    }
  }

  @SubscribeMessage('bot-tv-login-success')
  handleBotTvLoginSuccess(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; accountId: string }
  ) {
    const conn = this.connections.get(client.id);
    if (!conn || conn.type !== 'BOT')
      return;

    for (const c of this.connections.values()) {
      if (c.tenant_id === conn.tenant_id && c.type === 'DASHBOARD') {
        c.socket.emit('event', {
          eventName: 'bot-tv-login-success',
          payload: { taskId: data.taskId, accountId: data.accountId },
        });
      }
    }
  }

  @SubscribeMessage('bot-tv-progress')
  handleBotTvProgress(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; accountId: string; message: string }
  ) {
    const conn = this.connections.get(client.id);
    if (!conn || conn.type !== 'BOT')
      return;

    for (const c of this.connections.values()) {
      if (c.tenant_id === conn.tenant_id && c.type === 'DASHBOARD') {
        c.socket.emit('event', {
          eventName: 'bot-tv-progress',
          payload: { taskId: data.taskId, accountId: data.accountId, message: data.message },
        });
      }
    }
  }

  @SubscribeMessage('dashboard-send-tv-pin')
  handleDashboardSendTvPin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; pin: string; botSocketId: string }
  ) {
    const conn = this.connections.get(client.id);
    if (!conn || conn.type !== 'DASHBOARD')
      return;

    const botConn = this.connections.get(data.botSocketId);
    if (botConn && botConn.type === 'BOT') {
      botConn.socket.emit('tv-pin-input', { taskId: data.taskId, pin: data.pin });
    }
  }

  subscribeClientToEvent(clientId: string, eventName: string) {
    let event = this.events.get(eventName);
    if (!event) {
      this.events.set(eventName, new Set());
      event = this.events.get(eventName);
    }

    event!.add(clientId);
  }

  unsubscribeClientToEvent(clientId: string, eventName: string) {
    const event = this.events.get(eventName);
    if (!event) {
      return;
    }

    event.delete(clientId);
  }

  getConnection(clientId: string) {
    const conn = this.connections.get(clientId);
    if (!conn) {
      return undefined;
    }

    return {
      name: conn.name,
      type: conn.type,
      tenant_id: conn.tenant_id,
      inflight: conn.inflight,
      connectedAt: conn.connectedAt,
    };
  }

  private getAvailableBot(tenantId: string) {
    const candidates = Array.from(this.connections.values()).filter(
      c => c.tenant_id === tenantId && c.type === 'BOT',
    );
    if (!candidates.length)
      return undefined;
    if (candidates.length === 1)
      return candidates[0];

    candidates.sort((a, b) => {
      if (a.is_primary !== b.is_primary) {
        return a.is_primary ? -1 : 1;
      }
      if (a.inflight !== b.inflight)
        return a.inflight - b.inflight;
      return a.connectedAt - b.connectedAt;
    });

    return candidates[0];
  }
}
