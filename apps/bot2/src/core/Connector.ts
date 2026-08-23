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
}
