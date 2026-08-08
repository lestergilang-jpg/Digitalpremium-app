/**
 * TaskManager - Core task queue and execution manager
 */

import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import type { Database } from './Database.js';
import type { Logger } from './Logger.js';
import type { EventBus } from './EventBus.js';
import type { BaseModule } from './BaseModule.js';
import { getGlobalBrowser, createContext, closeGlobalBrowser, closeContext, getStorageStatePath, onBrowserDisconnect, onBrowserReady, waitForBrowserReady, isGlobalBrowserConnected, recycleGlobalBrowser } from '../utils/browser.js';
import { AppConfig } from '../types/config.type.js';
import { TaskRow } from '../types/database.type.js';
import { Task, TaskInput, TaskSource } from '../types/task.type.js';

interface RegisteredModule {
    instance: BaseModule;
    moduleName: string;  // Nama module (e.g., 'ShopeeOrderModule')
    loopInterval?: number;  // milliseconds delay setelah loop selesai
}

export class TaskManager {
    private config: AppConfig;
    private db: Database;
    private logger: Logger;
    private eventBus: EventBus;

    private modules: Map<string, RegisteredModule> = new Map();
    private runningTasks: Map<string, Task> = new Map();
    private taskTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private isRunning: boolean = false;
    private processInterval: NodeJS.Timeout | null = null;

    // Loop management state
    private loopTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private loopRunning: Map<string, boolean> = new Map();

    // Circuit breaker state
    private errorCounts: Map<string, number> = new Map();
    private circuitBrokenUntil: Map<string, number> = new Map();
    private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
    private readonly CIRCUIT_BREAKER_RESET_MS = 30 * 60 * 1000; // 30 minutes

    // Browser availability state
    private isBrowserAvailable: boolean = true;

    // Browser recycle scheduler state
    private recycleIntervalId: NodeJS.Timeout | null = null;
    private isRecycling: boolean = false;

    constructor(config: AppConfig, db: Database, logger: Logger, eventBus: EventBus) {
        this.config = config;
        this.db = db;
        this.logger = logger;
        this.eventBus = eventBus;
    }

    /**
     * Register a module instance
     */
    registerModule(instanceId: string, instance: BaseModule, moduleName: string, loopInterval?: number): void {
        this.modules.set(instanceId, { instance, moduleName, loopInterval });
        this.logger.info(`Module registered: ${instanceId} (${moduleName})`);
    }

    /**
     * Unregister a module instance
     */
    unregisterModule(instanceId: string): void {
        this.modules.delete(instanceId);
        this.logger.info(`Module unregistered: ${instanceId}`);
    }

    /**
     * Get registered module by instance id
     */
    getModule(instanceId: string): BaseModule | undefined {
        return this.modules.get(instanceId)?.instance;
    }

    /**
     * Get module instance by module name (not instance id)
     * Searches through registered modules and returns the first match
     * 
     * @param moduleName - The module name to search for (e.g., 'ShopeeOrderModule')
     * @returns Object containing instanceId and module instance, or undefined if not found
     */
    getModuleInstanceByModuleName(moduleName: string): { instanceId: string; instance: BaseModule } | undefined {
        for (const [instanceId, registered] of this.modules) {
            if (registered.moduleName === moduleName) {
                return { instanceId, instance: registered.instance };
            }
        }
        return undefined;
    }

    /**
     * Enqueue a new task
     */
    enqueueTask(input: TaskInput): string {
        const id = input.id || randomUUID();
        const source = input.source || 'INTERNAL';
        const now = new Date().toISOString();
        const executeAt = input.executeAt
            ? input.executeAt.toISOString()
            : now;  // default: immediate
        
        const maxRetries = input.maxRetries ?? 3;

        const result = this.db.run(
            `INSERT OR IGNORE INTO sys_tasks (id, module_instance_id, type, source, status, payload, execute_at, created_at, max_retries, retry_count)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, 0)`,
            [id, input.moduleInstanceId, input.type, source, JSON.stringify(input.payload || {}), executeAt, now, maxRetries]
        );

        if (result.changes === 0) {
            this.logger.debug(`Task ${id} already exists in local database, skipping enqueue`);
            return id;
        }

        this.logger.debug(`Task enqueued: ${id} (${input.type}) for ${input.moduleInstanceId}, source: ${source}, execute_at: ${executeAt}, max_retries: ${maxRetries}`);
        
        // Trigger immediate processing for external tasks so they run without delay
        if (source === 'EXTERNAL') {
            this.processTasks().catch(err => {
                this.logger.error(`Immediate task processing error: ${err instanceof Error ? err.message : 'Unknown error'}`);
            });
        }
        
        return id;
    }

    /**
     * Start the task manager
     */
    async start(): Promise<void> {
        this.isRunning = true;
        this.logger.info('TaskManager starting...');

        // Reset any RUNNING tasks to PENDING (from previous crash)
        this.db.run(
            `UPDATE sys_tasks SET status = 'PENDING' WHERE status = 'RUNNING'`
        );

        // Start loop modules
        for (const [instanceId, module] of this.modules) {
            if (module.instance.executeLoop) {
                this.startLoopModule(instanceId, module);
            }
        }

        // Start task processing loop
        this.processInterval = setInterval(() => {
            this.processTasks().catch(err => {
                this.logger.error(`Task processing error: ${err instanceof Error ? err.message : 'Unknown error'}`);
            });
        }, 1000);

        // Subscribe to browser events
        onBrowserDisconnect(() => this.handleBrowserDisconnect());
        onBrowserReady(() => this.handleBrowserReady());

        // Start browser recycle scheduler
        this.startBrowserRecycleScheduler();

        this.logger.info('TaskManager started');
    }

    /**
     * Start loop for a module with sequential execution
     * Next loop iteration starts only after current one completes
     */
    private startLoopModule(instanceId: string, module: RegisteredModule): void {
        if (!module.instance.executeLoop) return;

        const interval = module.loopInterval ?? this.config.app.default_loop_interval ?? 10000;
        this.loopRunning.set(instanceId, true);

        const runLoop = async () => {
            // Check apakah loop masih aktif dan TaskManager masih running
            if (!this.isRunning || !this.loopRunning.get(instanceId)) {
                this.loopRunning.delete(instanceId);
                this.loopTimeouts.delete(instanceId);
                return;
            }

            // Wait for browser if not available
            if (!this.isBrowserAvailable) {
                this.logger.debug(`Loop ${instanceId} waiting for browser...`);
                await waitForBrowserReady();
                this.logger.debug(`Loop ${instanceId} browser ready, continuing`);
            }

            try {
                await module.instance.executeLoop!();
            } catch (err) {
                this.logger.error(`Loop error (${instanceId}): ${err instanceof Error ? err.message : 'Unknown error'}`);
                // Loop tetap berlanjut meski ada error
            }

            // Schedule next loop SETELAH current loop selesai
            if (this.isRunning && this.loopRunning.get(instanceId)) {
                const timeoutId = setTimeout(runLoop, interval);
                this.loopTimeouts.set(instanceId, timeoutId);
            }
        };

        // Mulai loop pertama
        runLoop();
        this.logger.info(`Loop started: ${instanceId} (interval: ${interval}ms)`);
    }

    /**
     * Stop loop for a specific module
     */
    private stopLoopModule(instanceId: string): void {
        // Mark loop sebagai tidak aktif
        this.loopRunning.set(instanceId, false);

        // Clear pending timeout jika ada
        const timeout = this.loopTimeouts.get(instanceId);
        if (timeout) {
            clearTimeout(timeout);
            this.loopTimeouts.delete(instanceId);
        }

        this.loopRunning.delete(instanceId);
        this.logger.info(`Loop stopped: ${instanceId}`);
    }

    /**
     * Request module stop from a module itself
     * Stops the module's loop, fails all its pending tasks, and calls module.stop()
     * Called by BaseModule.requestStop() - allows child modules to ask parent to stop them
     */
    async requestModuleStop(instanceId: string, reason: string): Promise<void> {
        this.logger.warn(`Module ${instanceId} requested stop: ${reason}`);

        // 1. Stop loop
        if (this.loopRunning.has(instanceId)) {
            this.stopLoopModule(instanceId);
        }

        // 2. Fail all pending tasks for this module
        const pendingRows = this.db.all<TaskRow>(
            `SELECT * FROM sys_tasks WHERE module_instance_id = ? AND status = 'PENDING'`,
            [instanceId]
        );
        for (const row of pendingRows) {
            this.markTaskFailed(row.id, `Module stopped: ${reason}`, row.source as TaskSource);
        }

        // 3. Stop the module
        const registered = this.modules.get(instanceId);
        if (registered) {
            try {
                await registered.instance.stop();
            } catch (err) {
                this.logger.error(`Error stopping module ${instanceId}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
        }
    }

    /**
     * Stop the task manager
     */
    async stop(): Promise<void> {
        this.isRunning = false;
        this.logger.info('TaskManager stopping...');

        // Stop browser recycle scheduler
        if (this.recycleIntervalId) {
            clearInterval(this.recycleIntervalId);
            this.recycleIntervalId = null;
        }

        // Stop processing interval
        if (this.processInterval) {
            clearInterval(this.processInterval);
            this.processInterval = null;
        }

        // Clear all task timeouts
        for (const [taskId, timeout] of this.taskTimeouts) {
            clearTimeout(timeout);
            this.taskTimeouts.delete(taskId);
        }

        // Stop all loop modules
        for (const instanceId of this.loopRunning.keys()) {
            this.stopLoopModule(instanceId);
        }

        // Stop all modules
        for (const [instanceId, { instance }] of this.modules) {
            try {
                await instance.stop();
                this.logger.info(`Module stopped: ${instanceId}`);
            } catch (err) {
                this.logger.error(`Error stopping module ${instanceId}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
        }

        // Close global browser
        await closeGlobalBrowser();
        this.logger.info('Global browser closed');

        this.logger.info('TaskManager stopped');
    }

    /**
     * Process pending tasks from queue
     */
    private async processTasks(): Promise<void> {
        if (!this.isRunning) return;

        // Pause task processing during browser recycle
        if (this.isRecycling) {
            return;
        }

        // Check concurrency limit
        if (this.runningTasks.size >= this.config.app.max_concurrent_tasks) {
            return;
        }

        // Get pending tasks ready to execute
        const availableSlots = this.config.app.max_concurrent_tasks - this.runningTasks.size;
        const pendingRows = this.db.all<TaskRow>(
            `SELECT * FROM sys_tasks 
       WHERE status = 'PENDING' 
         AND datetime(execute_at) <= datetime('now')
       ORDER BY execute_at ASC 
       LIMIT ?`,
            [availableSlots]
        );

        for (const row of pendingRows) {
            // Check circuit breaker
            if (this.isCircuitBroken(row.module_instance_id)) {
                this.logger.debug(`Circuit broken for ${row.module_instance_id}, skipping task ${row.id}`);
                continue;
            }

            // Check if module exists
            const module = this.getModule(row.module_instance_id);
            if (!module) {
                this.logger.warn(`Module not found: ${row.module_instance_id}, failing task ${row.id}`);
                this.markTaskFailed(row.id, 'Module not found', row.source as TaskSource);
                continue;
            }

            // Execute task
            this.executeTask(row, module);
        }
    }

    /**
     * Execute a single task
     */
    private executeTask(row: TaskRow, module: BaseModule): void {
        const task: Task = {
            id: row.id,
            moduleInstanceId: row.module_instance_id,
            type: row.type,
            source: row.source as TaskSource,
            payload: JSON.parse(row.payload),
            status: 'RUNNING',
            executeAt: new Date(row.execute_at),
            createdAt: new Date(row.created_at),
            maxRetries: row.max_retries,
            retryCount: row.retry_count,
        };

        // Mark as running
        this.runningTasks.set(task.id, task);
        this.db.run(
            `UPDATE sys_tasks SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?`,
            [task.id]
        );

        // Set timeout (zombie killer)
        const timeoutId = setTimeout(() => {
            this.handleTaskTimeout(task.id);
        }, this.config.app.task_timeout_ms);
        this.taskTimeouts.set(task.id, timeoutId);

        this.logger.info(`Executing task: ${task.id} (${task.type}) for ${task.moduleInstanceId}`);

        // Execute task method
        this.doExecuteTask(task, module)
            .then((result) => {
                this.markTaskCompleted(task.id, task.source, result);
                this.resetErrorCount(task.moduleInstanceId);
            })
            .catch(err => {
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';

                // Check if error is due to browser disconnect - retry instead of fail
                if (this.isBrowserDisconnectError(errorMessage) && task.retryCount < task.maxRetries) {
                    this.logger.warn(`Task ${task.id} failed due to browser disconnect, will retry (${task.retryCount + 1}/${task.maxRetries})`);
                    this.markTaskForRetry(task.id);
                } else {
                    const failMessage = this.isBrowserDisconnectError(errorMessage)
                        ? `${errorMessage} (Max retries reached: ${task.maxRetries})`
                        : errorMessage;
                    this.markTaskFailed(task.id, failMessage, task.source);
                    this.incrementErrorCount(task.moduleInstanceId);
                }
            })
            .finally(() => {
                // Cleanup
                this.runningTasks.delete(task.id);
                const timeout = this.taskTimeouts.get(task.id);
                if (timeout) {
                    clearTimeout(timeout);
                    this.taskTimeouts.delete(task.id);
                }
            });
    }

    /**
     * Actually execute the task (with browser context injection)
     */
    private async doExecuteTask(task: Task, module: BaseModule): Promise<any> {
        // getToken does not require browser startup, execute directly
        if (task.type === 'getToken') {
            return await module.executeTaskMethod(task);
        }

        // Check if module already has a browser context (loop mode)
        let context = module.getBrowserContext();
        let ownContext = false;

        if (!context) {
            // Need to create a new context from global browser
            const browser = await getGlobalBrowser();
            const storagePath = getStorageStatePath(task.moduleInstanceId);
            context = await createContext(browser, storagePath);
            module.setBrowserContext(context);
            ownContext = true;
            this.logger.debug(`Created new browser context for task ${task.id}`);
        } else {
            this.logger.debug(`Reusing existing browser context for task ${task.id}`);
        }

        try {
            // Execute the task method
            return await module.executeTaskMethod(task);
        } finally {
            // Cleanup if we created the context
            if (ownContext) {
                await closeContext(context);
                module.setBrowserContext(null!);
                this.logger.debug(`Closed browser context for task ${task.id}`);
            }
        }
    }

    /**
     * Handle task timeout
     */
    private handleTaskTimeout(taskId: string): void {
        const task = this.runningTasks.get(taskId);
        if (!task) return;

        this.logger.warn(`Task timeout: ${taskId}`);
        this.markTaskFailed(taskId, 'Task timeout', task.source);
        this.incrementErrorCount(task.moduleInstanceId);
        this.runningTasks.delete(taskId);
        this.taskTimeouts.delete(taskId);

        // Emit timeout event
        this.eventBus.emit('task:timeout', { taskId, moduleInstanceId: task.moduleInstanceId, source: task.source });
    }

    /**
     * Mark task as completed
     */
    private markTaskCompleted(taskId: string, source: TaskSource, result?: any): void {
        this.db.run(
            `UPDATE sys_tasks SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?`,
            [taskId]
        );
        this.logger.info(`Task completed: ${taskId}`);
        this.eventBus.emit('task:completed', { taskId, source, result });
    }


    /**
     * Mark task as failed
     */
    private markTaskFailed(taskId: string, error: string, source: TaskSource): void {
        this.db.run(
            `UPDATE sys_tasks SET status = 'FAILED', completed_at = datetime('now'), error = ? WHERE id = ?`,
            [error, taskId]
        );
        this.logger.error(`Task failed: ${taskId} - ${error}`);
        this.eventBus.emit('task:failed', { taskId, error, source });
    }

    // ==========================================================================
    // Circuit Breaker
    // ==========================================================================

    private incrementErrorCount(moduleInstanceId: string): void {
        const count = (this.errorCounts.get(moduleInstanceId) || 0) + 1;
        this.errorCounts.set(moduleInstanceId, count);

        if (count >= this.CIRCUIT_BREAKER_THRESHOLD) {
            const resetTime = Date.now() + this.CIRCUIT_BREAKER_RESET_MS;
            this.circuitBrokenUntil.set(moduleInstanceId, resetTime);
            this.logger.warn(`Circuit breaker tripped for ${moduleInstanceId}, reset at ${new Date(resetTime).toISOString()}`);
        }
    }

    private resetErrorCount(moduleInstanceId: string): void {
        this.errorCounts.delete(moduleInstanceId);
        this.circuitBrokenUntil.delete(moduleInstanceId);
    }

    private isCircuitBroken(moduleInstanceId: string): boolean {
        const resetTime = this.circuitBrokenUntil.get(moduleInstanceId);
        if (!resetTime) return false;

        if (Date.now() >= resetTime) {
            // Reset circuit breaker
            this.resetErrorCount(moduleInstanceId);
            this.logger.info(`Circuit breaker reset for ${moduleInstanceId}`);
            return false;
        }

        return true;
    }

    // ==========================================================================
    // Browser Disconnect Handling
    // ==========================================================================

    /**
     * Handle browser disconnect event
     */
    private handleBrowserDisconnect(): void {
        this.isBrowserAvailable = false;
        this.logger.warn('Browser disconnected, operations will wait for restart...');

        // Invalidate all module contexts
        this.invalidateAllContexts();
    }

    /**
     * Handle browser ready event (after restart)
     */
    private handleBrowserReady(): void {
        this.isBrowserAvailable = true;
        this.logger.info('Browser ready, resuming operations');
    }

    /**
     * Invalidate all browser contexts in registered modules
     */
    private invalidateAllContexts(): void {
        for (const [instanceId, { instance }] of this.modules) {
            instance.invalidateAllContexts();
            this.logger.debug(`Invalidated all contexts for ${instanceId}`);
        }
    }

    /**
     * Check if error message indicates browser disconnect
     */
    private isBrowserDisconnectError(errorMessage: string): boolean {
        const disconnectPatterns = [
            'browser has been closed',
            'browser disconnected',
            'target closed',
            'connection closed',
            'browser was disconnected',
        ];
        const lowerMessage = errorMessage.toLowerCase();
        return disconnectPatterns.some(pattern => lowerMessage.includes(pattern));
    }

    /**
     * Mark task for retry (set back to PENDING)
     */
    private markTaskForRetry(taskId: string): void {
        this.db.run(
            `UPDATE sys_tasks SET status = 'PENDING', started_at = NULL, retry_count = retry_count + 1 WHERE id = ?`,
            [taskId]
        );
        this.logger.info(`Task ${taskId} marked for retry`);
    }

    // ==========================================================================
    // Browser Recycle Scheduler
    // ==========================================================================

    /**
     * Start browser recycle scheduler
     */
    private startBrowserRecycleScheduler(): void {
        const intervalMinutes = this.config.app.browser_recycle_interval_minutes ?? 60;
        const intervalMs = intervalMinutes * 60 * 1000;

        this.logger.info(`Browser recycle scheduler started (interval: ${intervalMinutes} minutes)`);

        this.recycleIntervalId = setInterval(() => {
            this.recycleBrowser().catch(err => {
                this.logger.error(`Browser recycle error: ${err instanceof Error ? err.message : 'Unknown error'}`);
            });
        }, intervalMs);
    }

    /**
     * Recycle global browser
     * Orchestrates: stop loops -> wait for tasks -> save sessions -> recycle browser -> restart loops
     */
    private async recycleBrowser(): Promise<void> {
        if (this.isRecycling) return;

        this.isRecycling = true;
        this.isBrowserAvailable = false;
        this.logger.info('Starting browser recycle...');

        // 1. Stop all module loops
        const loopModuleIds = Array.from(this.loopRunning.keys());
        for (const instanceId of loopModuleIds) {
            this.stopLoopModule(instanceId);
        }

        // 2. Wait for all running tasks to complete
        while (this.runningTasks.size > 0) {
            this.logger.debug(`Waiting for ${this.runningTasks.size} running tasks to complete...`);
            await new Promise(r => setTimeout(r, 1000));
        }

        // 3. Save all module sessions & invalidate contexts
        for (const [instanceId, { instance }] of this.modules) {
            try {
                await instance.saveAllSessions();
            } catch (err) {
                this.logger.warn(`Failed to save sessions for ${instanceId}: ${err instanceof Error ? err.message : 'Unknown'}`);
            }
            instance.invalidateAllContexts();
        }

        // 4. Recycle browser
        await recycleGlobalBrowser();
        this.logger.info('Browser recycled successfully');

        // 5. Resume operations
        this.isBrowserAvailable = true;
        this.isRecycling = false;

        // 6. Restart module loops
        for (const [instanceId, module] of this.modules) {
            if (module.instance.executeLoop) {
                this.startLoopModule(instanceId, module);
            }
        }

        this.logger.info('Browser recycle completed, operations resumed');
    }

    // ==========================================================================
    // Status & Info
    // ==========================================================================

    /**
     * Get task manager status
     */
    getStatus(): {
        isRunning: boolean;
        runningTasksCount: number;
        maxConcurrentTasks: number;
        registeredModules: string[];
    } {
        return {
            isRunning: this.isRunning,
            runningTasksCount: this.runningTasks.size,
            maxConcurrentTasks: this.config.app.max_concurrent_tasks,
            registeredModules: Array.from(this.modules.keys()),
        };
    }

    /**
     * Get running task by id
     */
    getRunningTask(taskId: string): Task | undefined {
        return this.runningTasks.get(taskId);
    }
}
