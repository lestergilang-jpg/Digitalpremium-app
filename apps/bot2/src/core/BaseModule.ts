/**
 * BaseModule - Abstract base class for all modules
 */

import type { BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { Database } from './Database.ts';
import type { Logger } from './Logger.ts';
import type { EventBus } from './EventBus.ts';
import type { TaskManager } from './TaskManager.ts';
import type { ModuleDependencies } from '../types/module.type.ts';
import type { AuthCredentials } from './auth.js';
import {
    getGlobalBrowser,
    createContext,
    saveStorageState,
    getStorageStatePath,
    closeContext,
} from '../utils/browser.js';
import type { ModuleConfig } from '../types/config.type.js';
import type { Task } from '../types/task.type.js';

export abstract class BaseModule {
    protected db: Database;
    protected logger: Logger;
    protected eventBus: EventBus;
    protected taskManager: TaskManager;
    protected apiBaseUrl: string;
    protected authCredentials: AuthCredentials;

    readonly instanceId: string;
    readonly config: ModuleConfig;

    // Browser context management (browser is global singleton)
    private static readonly DEFAULT_CONTEXT_NAME = 'default';
    protected browserContexts: Map<string, BrowserContext> = new Map();
    private isRunning: boolean = false;
    private lastSavedSessionHash: Map<string, string> = new Map();

    constructor(deps: ModuleDependencies, instanceId: string, config: ModuleConfig) {
        this.db = deps.db;
        this.logger = deps.logger.child(instanceId);
        this.eventBus = deps.eventBus;
        this.taskManager = deps.taskManager;
        this.apiBaseUrl = deps.apiBaseUrl;
        this.authCredentials = deps.authCredentials;
        this.instanceId = instanceId;
        this.config = config;
    }

    // ==========================================================================
    // Abstract methods - must be implemented by subclasses
    // ==========================================================================

    /**
     * Setup database schema for this module (CREATE TABLE IF NOT EXISTS)
     */
    abstract setupSchema(): Promise<void>;

    /**
     * Initialize module (load state, prepare resources)
     */
    abstract init(): Promise<void>;

    /**
     * Graceful shutdown
     */
    abstract stop(): Promise<void>;

    // ==========================================================================
    // Optional methods - can be overridden by subclasses
    // ==========================================================================

    /**
     * Loop iteration handler - override this for loop modules
     * This is called repeatedly by TaskManager at configured interval
     * Each call represents ONE iteration of the loop
     */
    async executeLoop?(): Promise<void>;

    // ==========================================================================
    // Browser management helpers
    // ==========================================================================

    /**
     * Get or create browser context from global browser
     * @param contextName - Name of the context (default: 'default')
     */
    public async getOrCreateContext(
        contextName: string = BaseModule.DEFAULT_CONTEXT_NAME,
        options?: { blockAssets?: boolean }
    ): Promise<BrowserContext> {
        // Validate existing context - check if browser is still connected
        const existingContext = this.browserContexts.get(contextName);
        if (existingContext) {
            try {
                const browser = existingContext.browser();
                if (browser && browser.isConnected()) {
                    return existingContext;
                }
            } catch {
                // Context is invalid, clear it
            }
            // Browser disconnected, need to recreate context
            this.browserContexts.delete(contextName);
            this.logger.debug(`Browser context '${contextName}' invalidated, will recreate`);
        }

        // Get global browser instance (lazy initialization)
        const browser = await getGlobalBrowser();

        let storageState: any = null;
        try {
            // Determine identifier (usually email in contextName, fallback)
            const identifier = contextName;
            const response = await fetch(`${this.apiBaseUrl}/public/session/${this.instanceId}/${identifier}`, {
                headers: { 
                    'Authorization': `Bearer ${this.authCredentials.token}`,
                    'x-tenant-id': this.authCredentials.tenantId
                }
            });
            
            if (response.ok) {
                storageState = await response.json();
                this.logger.debug(`Loaded session state from DB for ${contextName}`);
            } else {
                this.logger.debug(`No session state found in DB for ${contextName} (${response.status})`);
            }
        } catch (err: any) {
            this.logger.warn(`Failed to fetch session state for ${contextName}: ${err.message}`);
        }

        const context = await createContext(browser, storageState, options);
        this.browserContexts.set(contextName, context);
        this.logger.debug(`Browser context '${contextName}' created from global browser`);

        return context;
    }

    /**
     * Invalidate specific browser context (called when browser disconnects)
     * Does not close context since browser is already gone
     * @param contextName - Name of the context to invalidate (default: 'default')
     */
    invalidateContext(contextName: string = BaseModule.DEFAULT_CONTEXT_NAME): void {
        this.browserContexts.delete(contextName);
        this.logger.debug(`Browser context '${contextName}' invalidated`);
    }

    /**
     * Invalidate all browser contexts (called when browser disconnects)
     */
    invalidateAllContexts(): void {
        this.browserContexts.clear();
        this.logger.debug('All browser contexts invalidated');
    }

    /**
     * Save specific context session state
     * @param contextName - Name of the context to save (default: 'default')
     */
    async saveSession(contextName: string = BaseModule.DEFAULT_CONTEXT_NAME): Promise<void> {
        const context = this.browserContexts.get(contextName);
        if (!context) return;
        try {
            const storageState = await saveStorageState(context);
            const sessionData = storageState;
            const cacheKey = `${this.instanceId}:${contextName}`;
            
            const cookiesStr = sessionData.cookies 
                ? JSON.stringify(sessionData.cookies.map((c: any) => ({ name: c.name, value: c.value }))) 
                : JSON.stringify(sessionData);

            if (this.lastSavedSessionHash.get(cacheKey) === cookiesStr) {
                return; // Avoid spamming if cookies haven't changed
            }

            this.lastSavedSessionHash.set(cacheKey, cookiesStr);

            this.eventBus.emit('socket:session-updated', {
                platform: this.instanceId,
                identifier: contextName,
                sessionData,
            });
            this.logger.debug(`Session cookies saved for ${this.instanceId}:${contextName} to database`);
        } catch (e: any) {
            this.logger.error(`Failed to read or emit session update: ${e.message}`);
        }
    }

    /**
     * Save all context sessions
     */
    async saveAllSessions(): Promise<void> {
        for (const [contextName] of this.browserContexts) {
            await this.saveSession(contextName);
        }
    }

    // ==========================================================================
    // Lifecycle helpers
    // ==========================================================================

    /**
     * Mark module as running
     */
    protected setRunning(running: boolean): void {
        this.isRunning = running;
    }

    /**
     * Check if module is running
     */
    protected getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Cleanup resources on stop
     * Note: Only closes context, global browser is managed by TaskManager
     */
    protected async cleanup(): Promise<void> {
        this.setRunning(false);

        // Save all sessions
        await this.saveAllSessions();

        // Close all contexts
        for (const [contextName, context] of this.browserContexts) {
            await closeContext(context);
            this.logger.debug(`Context '${contextName}' closed`);
        }
        this.browserContexts.clear();

        this.logger.info('Module cleanup completed');
    }

    /**
     * Request module stop from TaskManager (parent)
     * Stops loop, fails pending tasks, and calls this.stop()
     */
    protected async requestStop(reason: string): Promise<void> {
        await this.taskManager.requestModuleStop(this.instanceId, reason);
    }

    // ==========================================================================
    // Task helpers
    // ==========================================================================

    /**
     * Enqueue a task for this module
     */
    protected enqueueTask(type: string, payload: Record<string, unknown> = {}): string {
        return this.taskManager.enqueueTask({
            moduleInstanceId: this.instanceId,
            type,
            payload,
        });
    }

    /**
     * Emit an event with module prefix
     */
    protected emitEvent(eventName: string, data?: unknown): void {
        const fullEventName = `${this.instanceId}:${eventName}`;
        this.eventBus.emit(fullEventName, data);
    }

    /**
     * Subscribe to an event
     */
    protected onEvent<T = unknown>(eventName: string, handler: (data: T) => void | Promise<void>): void {
        this.eventBus.on(eventName, handler);
    }

    /**
     * Wait for an event from EventBus with reactive timeout from TaskManager
     * Uses task:timeout event as abort signal instead of internal timer
     * @param taskId - The current task ID for matching timeout signal
     * @param eventName - The event name to wait for
     * @returns Promise that resolves with event data or rejects on timeout
     */
    protected waitForTaskEvent<T>(taskId: string, eventName: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            // Handlers that will be registered
            let successHandler: ((data: T) => void) | null = null;
            let timeoutHandler: ((data: { taskId: string }) => void) | null = null;

            // Cleanup function to remove all listeners
            const cleanup = () => {
                if (successHandler) {
                    this.eventBus.off(eventName, successHandler);
                }
                if (timeoutHandler) {
                    this.eventBus.off('task:timeout', timeoutHandler);
                }
            };

            // Success handler - resolve and cleanup
            successHandler = (data: T) => {
                cleanup();
                resolve(data);
            };

            // Timeout handler - check taskId match, reject and cleanup
            timeoutHandler = (data: { taskId: string }) => {
                if (data.taskId === taskId) {
                    cleanup();
                    reject(new Error('Task aborted by Manager: timeout'));
                }
            };

            // Register listeners
            this.eventBus.once(eventName, successHandler);
            this.eventBus.on('task:timeout', timeoutHandler);
        });
    }

    // ==========================================================================
    // Utility helpers
    // ==========================================================================

    /**
     * Sleep helper
     */
    protected sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get default browser context (for TaskManager to inject into tasks)
     * Backward compatible - returns default context
     */
    getBrowserContext(): BrowserContext | null {
        return this.browserContexts.get(BaseModule.DEFAULT_CONTEXT_NAME) ?? null;
    }

    /**
     * Set default browser context (for TaskManager to inject context)
     * Backward compatible - sets default context
     */
    setBrowserContext(context: BrowserContext): void {
        this.browserContexts.set(BaseModule.DEFAULT_CONTEXT_NAME, context);
    }

    /**
     * Get specific browser context by name
     */
    getContextByName(contextName: string): BrowserContext | null {
        return this.browserContexts.get(contextName) ?? null;
    }

    /**
     * Get all context names
     */
    getContextNames(): string[] {
        return Array.from(this.browserContexts.keys());
    }

    /**
     * Execute a task method by name
     * TaskManager calls this to run task.type as a method on the module
     */
    async executeTaskMethod(task: Task): Promise<any> {
        const methodName = task.type;
        const method = (this as unknown as Record<string, unknown>)[methodName];

        if (typeof method !== 'function') {
            throw new Error(`Method '${methodName}' not found in module '${this.instanceId}'`);
        }

        return await (method as (task: Task) => Promise<any>).call(this, task);
    }
}

