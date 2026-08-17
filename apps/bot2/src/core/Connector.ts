/**
 * Connector - Socket.IO client for external server communication
 */

import { io, type Socket } from "socket.io-client";
import fs from "fs";
import path from "path";
import type { TaskManager } from "./TaskManager.js";
import type { Logger } from "./Logger.js";
import type { EventBus } from "./EventBus.js";
import { AppConfig } from "../types/config.type.js";
import type { ConnectorConfig } from "../types/config.type.js";
import { TaskInput, TaskSource } from "../types/task.type.js";
import type { AuthCredentials } from "./auth.js";
import {
  ConnectorConnectErrorData,
  DispatchTaskData,
  EventData,
  RejectTaskData,
  TaskDoneData,
} from "../types/connector.type.js";
import { buildSocketBaseUrl } from "../utils/api-url.js";

interface GetStatusPayload {
  requestId: string;
  statusEndpoint: string;
}

export class Connector {
  private socketBaseUrl: string;
  private appName: string;
  private config: ConnectorConfig;
  private authCredentials: AuthCredentials;
  private taskManager: TaskManager;
  private logger: Logger;
  private eventBus: EventBus;
  private isPrimary: boolean;
  private appConfig: AppConfig;

  private socket: Socket | null = null;
  private isConnected: boolean = false;
  private hasSyncedSessions: boolean = false;

  constructor(
    config: AppConfig,
    authCredentials: AuthCredentials,
    taskManager: TaskManager,
    logger: Logger,
    eventBus: EventBus,
  ) {
    this.socketBaseUrl = buildSocketBaseUrl(config.app.api_base_url);
    this.appName = config.app.name;
    this.config = config.connector;
    this.appConfig = config;
    this.authCredentials = authCredentials;
    this.taskManager = taskManager;
    this.logger = logger;
    this.eventBus = eventBus;
    this.isPrimary = config.app.is_primary;
  }

  /**
   * Connect to the server
   */
  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info("Connector is disabled");
      return;
    }

    return new Promise((resolve, reject) => {
      this.logger.info(`Connecting to server: ${this.socketBaseUrl}`);

      this.socket = io(this.socketBaseUrl, {
        auth: {
          token: this.authCredentials.token,
        },
        query: {
          connection_name: this.appName,
          connection_type: "BOT",
          is_primary: this.isPrimary ? "true" : "false",
        },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
      });

      this.socket.on("connect", () => {
        this.isConnected = true;
        this.logger.info("Connected to server");
        if (!this.hasSyncedSessions) {
          this.hasSyncedSessions = true;
          this.syncSessionsToDatabase();
        }
        resolve();
      });

      this.socket.on("disconnect", (reason) => {
        this.isConnected = false;
        this.logger.warn(`Disconnected from server: ${reason}`);
      });

      this.socket.on("connect_error", (error: any) => {
        const fatalErrors = [
          "ValidationError",
          "InternalServerError",
          "InvalidTokenError",
        ];
        const errorData =
          (error.data as ConnectorConnectErrorData) || undefined;

        if (errorData && fatalErrors.includes(errorData.type)) {
          this.socket?.disconnect();
          this.socket?.removeAllListeners();
          reject(new Error(errorData.message));
        }

        this.logger.error(`Connection error: ${error.message}`);
      });

      // Register command handlers
      this.registerHandlers();
    });
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
      this.logger.info("Disconnected from server");
    }
  }

  /**
   * Check if connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Register event handlers for server commands
   */
  private registerHandlers(): void {
    if (!this.socket) return;

    // Handle unified task-dispatch event
    this.socket.on("task-dispatch", (payload: DispatchTaskData) => {
      this.handleTaskDispatch(payload);
    });

    // Handle event event
    this.socket.on("event", (payload: EventData) => {
      this.handleEvent(payload);
    });

    // Handle get_status command (response via fetch API)
    this.socket.on("get_status", (payload: GetStatusPayload) => {
      this.handleGetStatus(payload);
    });

    // Handle get_netflix_cookies
    this.socket.on("get_netflix_cookies", (payload: { email: string }, callback: (response: any) => void) => {
      this.handleGetNetflixCookies(payload, callback);
    });

    // Handle get_netflix_token_link
    this.socket.on("get_netflix_token_link", (payload: { email: string }, callback: (response: any) => void) => {
      this.handleGetNetflixTokenLink(payload, callback);
    });

    // Handle import_netflix_cookies
    this.socket.on("import_netflix_cookies", (payload: { email: string; cookies: any }, callback: (response: any) => void) => {
      this.handleImportNetflixCookies(payload, callback);
    });

    // Handle TV PIN input from dashboard
    this.socket.on("tv-pin-input", (payload: { taskId: string; pin: string }) => {
      this.logger.info(`Received TV PIN for task ${payload.taskId}`);
      
      // Find which module is running this task
      const task = this.taskManager.getRunningTask(payload.taskId);
      if (task) {
        // Emit to internal event bus using the module's instance ID as prefix
        this.eventBus.emit(`${task.moduleInstanceId}:dashboard-send-tv-pin`, { taskId: payload.taskId, pin: payload.pin });
      } else {
        this.logger.warn(`Received TV PIN for task ${payload.taskId} but task is not running locally`);
      }
    });

    // Subscribe ke EventBus untuk task completion events
    this.subscribeToTaskEvents();

    // Listen for local subscription requests from modules
    this.eventBus.on('socket:subscribe', (eventName: string) => {
      this.subscribeToEvent(eventName);
    });
    this.eventBus.on('socket:unsubscribe', (eventName: string) => {
      this.unsubscribeToEvent(eventName);
    });
    this.eventBus.on('socket:bot-awaiting-tv-pin', (data: { taskId: string; accountId: string }) => {
      this.emitBotAwaitingTvPin(data.taskId, data.accountId);
    });
    this.eventBus.on('socket:bot-tv-pin-error', (data: { taskId: string; message: string }) => {
      this.emitBotTvPinError(data.taskId, data.message);
    });
    this.eventBus.on('socket:bot-tv-login-success', (data: { taskId: string; accountId: string }) => {
      this.emitBotTvLoginSuccess(data.taskId, data.accountId);
    });
    this.eventBus.on('socket:bot-tv-progress', (data: { taskId: string; accountId: string; message: string }) => {
      this.emitBotTvProgress(data.taskId, data.accountId, data.message);
    });
    this.eventBus.on('socket:session-updated', (data: { platform: string; identifier: string; sessionData: any }) => {
      if (this.socket && this.isConnected) {
        this.socket.emit('save-account-session', data);
        this.logger.info(`Emitted save-account-session for ${data.platform}:${data.identifier}`);
      }
    });

    this.logger.debug("Command handlers registered");
  }

  /**
   * Emit bot-awaiting-tv-pin event to the server
   */
  emitBotAwaitingTvPin(taskId: string, accountId: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("bot-awaiting-tv-pin", { taskId, accountId });
    this.logger.info(`Emitted bot-awaiting-tv-pin for task ${taskId}`);
  }

  /**
   * Emit bot-tv-pin-error event to the server
   */
  emitBotTvPinError(taskId: string, message: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("bot-tv-pin-error", { taskId, message });
    this.logger.info(`Emitted bot-tv-pin-error for task ${taskId}`);
  }

  /**
   * Emit bot-tv-login-success event to the server
   */
  emitBotTvLoginSuccess(taskId: string, accountId: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("bot-tv-login-success", { taskId, accountId });
    this.logger.info(`Emitted bot-tv-login-success for task ${taskId}`);
  }

  /**
   * Emit bot-tv-progress event to the server
   */
  emitBotTvProgress(taskId: string, accountId: string, message: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("bot-tv-progress", { taskId, accountId, message });
  }

  /**
   * Subscribe to an event on the server
   */
  subscribeToEvent(eventName: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("subscribe-event", { eventName });
    this.logger.debug(`Sent subscribe-event for: ${eventName}`);
  }

  /**
   * Unsubscribe from an event on the server
   */
  unsubscribeToEvent(eventName: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("unsubscribe-event", { eventName });
    this.logger.debug(`Sent unsubscribe-event for: ${eventName}`);
  }

  /**
   * Handle task-dispatch event
   * Unified handler untuk trigger dan scheduled tasks
   */
  private handleTaskDispatch(data: DispatchTaskData): void {
    try {
      this.logger.info(
        `Received task-dispatch: ${data.taskId} for module ${data.module}`,
      );

      if (!data.module) {
        this.emitTaskReject({
          taskId: data.taskId,
          message: "Module is required",
        });
        return;
      }

      // Find module instance by module name
      const result = this.taskManager.getModuleInstanceByModuleName(
        data.module,
      );
      if (!result) {
        this.logger.warn(`Module not found: ${data.module}`);
        this.emitTaskReject({
          taskId: data.taskId,
          message: `Module not found: ${data.module}`,
        });
        return;
      }

      const { instanceId, instance } = result;

      // Bypass TaskManager queue for instant non-blocking multithreaded tasks
      if (data.type === 'getToken') {
        this.logger.info(
          `Executing task ${data.taskId} (getToken) instantly in multithreaded mode`,
        );
        const task = {
          id: data.taskId,
          moduleInstanceId: instanceId,
          type: data.type,
          source: "EXTERNAL" as const,
          payload: data.payload,
          status: "RUNNING" as const,
          executeAt: new Date(),
          createdAt: new Date(),
          maxRetries: 1,
          retryCount: 0,
        };

        instance.executeTaskMethod(task)
          .then((res: any) => {
            this.emitTaskDone({
              taskId: data.taskId,
              status: "COMPLETED",
              payload: res,
            });
          })
          .catch((err: any) => {
            this.logger.error(`Immediate task error: ${err.message}`);
            this.emitTaskDone({
              taskId: data.taskId,
              status: "FAILED",
              message: err.message,
            });
          });
        return;
      }

      // Enqueue task with server's taskId and EXTERNAL source
      const taskInput: TaskInput = {
        id: data.taskId,
        moduleInstanceId: instanceId,
        type: data.type || "processTask",
        source: "EXTERNAL", // Mark as external task for status reporting
        payload: data.payload,
        executeAt: data.executeAt ? new Date(data.executeAt) : undefined,
        maxRetries: data.options?.maxRetries,
      };

      this.taskManager.enqueueTask(taskInput);
      this.logger.info(
        `Task enqueued: ${data.taskId} for instance ${instanceId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error handling task-dispatch: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      this.emitTaskReject({
        taskId: data.taskId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Handle event event
   */
  private handleEvent(data: EventData): void {
    try {
      this.logger.info(`Received event: ${data.eventName}`);
      // TODO #send-event
      this.eventBus.emit(data.eventName, data.payload);
    } catch (error) {
      this.logger.error(
        `Error handling event: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Emit task-reject event ke server
   */
  private emitTaskReject(data: RejectTaskData): void {
    if (!this.socket || !this.isConnected) {
      this.logger.warn("Cannot emit task-reject: not connected");
      return;
    }
    this.socket.emit("task-reject", data);
    this.logger.debug(`Emitted task-reject for ${data.taskId}`);
  }

  /**
   * Emit task-done event ke server
   */
  private emitTaskDone(data: TaskDoneData): void {
    if (!this.socket || !this.isConnected) {
      this.logger.warn("Cannot emit task-done: not connected");
      return;
    }
    this.socket.emit("task-done", data);
    this.logger.debug(`Emitted task-done for ${data.taskId}: ${data.status}`);
  }

  /**
   * Subscribe ke EventBus untuk menerima task completion events
   * Hanya task dengan source 'EXTERNAL' yang dikirim ke server
   */
  private subscribeToTaskEvents(): void {
    // Task completed
    this.eventBus.on<{ taskId: string; source: TaskSource; result?: any }>(
      "task:completed",
      (data) => {
        if (data && data.source === "EXTERNAL") {
          this.emitTaskDone({
            taskId: data.taskId,
            status: "COMPLETED",
            payload: data.result,
          });
        }
      },
    );

    // Task failed
    this.eventBus.on<{ taskId: string; error: string; source: TaskSource }>(
      "task:failed",
      (data) => {
        if (data && data.source === "EXTERNAL") {
          this.emitTaskDone({
            taskId: data.taskId,
            status: "FAILED",
            message: data.error,
          });
        }
      },
    );

    // Task timeout (considered as failed)
    this.eventBus.on<{
      taskId: string;
      moduleInstanceId: string;
      source: TaskSource;
    }>("task:timeout", (data) => {
      if (data && data.source === "EXTERNAL") {
        this.emitTaskDone({
          taskId: data.taskId,
          status: "FAILED",
          message: "Task timeout",
        });
      }
    });
  }

  /**
   * Handle get_status command - send response via fetch API
   */
  private async handleGetStatus(payload: GetStatusPayload): Promise<void> {
    try {
      this.logger.debug(`Received get_status request: ${payload.requestId}`);

      const status = {
        requestId: payload.requestId,
        timestamp: new Date().toISOString(),
        taskManager: this.taskManager.getStatus(),
      };

      // Send status via fetch API
      const response = await fetch(payload.statusEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `VC ${this.authCredentials.token}`,
          "x-tenant-id": this.authCredentials.tenantId,
        },
        body: JSON.stringify(status),
      });

      if (!response.ok) {
        this.logger.warn(`Failed to send status: ${response.status}`);
      } else {
        this.logger.debug("Status sent successfully");
      }
    } catch (error) {
      this.logger.error(
        `Error handling get_status: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private handleGetNetflixCookies(payload: { email: string }, callback: (response: any) => void): void {
    try {
      this.logger.info(`[Connector] Handling get_netflix_cookies for email: ${payload.email}`);
      // Use the exact same regex as sanitizeEmail: replace all . and @ with _
      const emailFileName = payload.email.toLowerCase().replace(/[.@]/g, '_');
      
      const cloudDataDir = this.appConfig.app.cloud_data_dir;
      const sessionPath = cloudDataDir
        ? path.join(cloudDataDir, "session_data", `netflix_${emailFileName}.json`)
        : path.join(process.cwd(), "session_data", `netflix_${emailFileName}.json`);

      if (!fs.existsSync(sessionPath)) {
        return callback({ error: `Session cookies not found for this account on bot. Searched path: ${sessionPath}` });
      }

      const sessionData = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      const netflixIdCookie = sessionData.cookies?.find((c: any) => c.name === "NetflixId");

      if (!netflixIdCookie) {
        return callback({ error: "NetflixId cookie not found in session." });
      }

      callback({ 
        cookie: netflixIdCookie.value,
        cookies: sessionData.cookies 
      });
    } catch (error) {
      this.logger.error(`[Connector] Error fetching cookies: ${(error as Error).message}`);
      callback({ error: (error as Error).message });
    }
  }
  private async handleGetNetflixTokenLink(payload: { email: string }, callback: (response: any) => void): Promise<void> {
    try {
      this.logger.info(`[Connector] Handling get_netflix_token_link for email: ${payload.email}`);
      const emailFileName = payload.email.toLowerCase().replace(/[.@]/g, '_');
      
      const cloudDataDir = this.appConfig.app.cloud_data_dir;
      const sessionPath = cloudDataDir
        ? path.join(cloudDataDir, "session_data", `netflix_${emailFileName}.json`)
        : path.join(process.cwd(), "session_data", `netflix_${emailFileName}.json`);

      if (!fs.existsSync(sessionPath)) {
        return callback({ error: `Session cookies not found for this account on bot.` });
      }

      const sessionData = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      const netflixIdCookie = sessionData.cookies?.find((c: any) => c.name === "NetflixId");
      const secureNetflixIdCookie = sessionData.cookies?.find((c: any) => c.name === "SecureNetflixId");
      const nfvdidCookie = sessionData.cookies?.find((c: any) => c.name === "nfvdid");

      if (!netflixIdCookie) {
        return callback({ error: "NetflixId cookie not found in session." });
      }

      const cookieStrings: string[] = [];
      if (netflixIdCookie) cookieStrings.push(`NetflixId=${netflixIdCookie.value}`);
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

      const fetchResponse = await fetch(urlObj.toString(), {
        method: "GET",
        headers: headers
      });

      if (!fetchResponse.ok) {
        const errText = await fetchResponse.text();
        this.logger.error(`[Connector] FTL API Error: ${fetchResponse.status} - ${errText}`);
        return callback({ error: `Netflix FTL API Error: ${fetchResponse.status}` });
      }

      const resJson = (await fetchResponse.json()) as any;
      const nftoken = resJson?.value?.account?.token?.default?.token;

      if (!nftoken) {
        return callback({ error: "nftoken not found in FTL response." });
      }

      callback({ token: nftoken });
    } catch (error) {
      this.logger.error(`[Connector] Error fetching token link: ${(error as Error).message}`);
      callback({ error: (error as Error).message });
    }
  }

  private async handleImportNetflixCookies(payload: { email: string; cookies: any }, callback: (response: any) => void): Promise<void> {
    try {
      this.logger.info(`[Connector] Handling import_netflix_cookies for email: ${payload.email}`);
      const emailFileName = payload.email.toLowerCase().replace(/[.@]/g, '_');
      
      const cloudDataDir = this.appConfig.app.cloud_data_dir;
      const sessionDir = cloudDataDir
        ? path.join(cloudDataDir, "session_data")
        : path.join(process.cwd(), "session_data");

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const sessionPath = path.join(sessionDir, `netflix_${emailFileName}.json`);
      
      // Make it smart: handle both Array and { cookies: Array }
      let cookiesArray = Array.isArray(payload.cookies) ? payload.cookies : (payload.cookies.cookies || []);
      
      // Sanitize sameSite for Playwright compatibility
      cookiesArray = cookiesArray.map((c: any) => {
        // Handle sameSite
        if (c.sameSite === null || c.sameSite === undefined) {
          delete c.sameSite;
        } else if (typeof c.sameSite === 'string') {
          const lower = c.sameSite.toLowerCase();
          if (lower === 'no_restriction' || lower === 'none') {
            c.sameSite = 'None';
          } else if (lower === 'lax') {
            c.sameSite = 'Lax';
          } else if (lower === 'strict') {
            c.sameSite = 'Strict';
          } else {
            delete c.sameSite;
          }
        } else {
          delete c.sameSite;
        }

        // Clean up other properties that Playwright might reject from extensions
        delete c.hostOnly;
        delete c.session;
        delete c.storeId;
        
        return c;
      });

      const cookiesToSave = { cookies: cookiesArray };

      fs.writeFileSync(sessionPath, JSON.stringify(cookiesToSave, null, 2), "utf-8");
      this.logger.info(`[Connector] Successfully imported cookies for ${payload.email} to ${sessionPath}`);
      
      callback({ success: true });
    } catch (error) {
      this.logger.error(`[Connector] Error importing cookies: ${(error as Error).message}`);
      callback({ error: (error as Error).message });
    }
  }

  private async syncSessionsToDatabase(): Promise<void> {
    try {
      const cloudDataDir = this.appConfig.app.cloud_data_dir;
      const sessionDir = cloudDataDir
        ? path.join(cloudDataDir, "session_data")
        : path.join(process.cwd(), "session_data");

      if (!fs.existsSync(sessionDir)) {
        return;
      }

      const files = fs.readdirSync(sessionDir);
      const netflixFiles = files.filter(f => f.startsWith('netflix_') && f.endsWith('.json'));

      this.logger.info(`[Connector] Starting startup session sync: found ${netflixFiles.length} Netflix sessions`);

      const batchSize = 100;
      let currentBatch: Array<{ platform: string; identifier: string; sessionData: any }> = [];

      for (const file of netflixFiles) {
        const identifier = file.replace(/^netflix_/, '').replace(/\.json$/, '');
        const filePath = path.join(sessionDir, file);
        try {
          const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (sessionData && sessionData.cookies) {
            currentBatch.push({
              platform: 'netflix',
              identifier,
              sessionData,
            });
          }

          if (currentBatch.length >= batchSize) {
            this.socket?.emit('save-account-sessions-batch', { sessions: currentBatch });
            currentBatch = [];
            // Sleep briefly to avoid overloading the socket connection / database
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } catch (e: any) {
          this.logger.warn(`Failed to sync session file ${file}: ${e.message}`);
        }
      }

      if (currentBatch.length > 0) {
        this.socket?.emit('save-account-sessions-batch', { sessions: currentBatch });
      }

      this.logger.info(`[Connector] Startup session sync initiated asynchronously.`);
    } catch (error: any) {
      this.logger.error(`Error during session sync: ${error.message}`);
    }
  }
}
