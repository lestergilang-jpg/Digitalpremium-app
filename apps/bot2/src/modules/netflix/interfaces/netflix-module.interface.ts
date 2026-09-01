import type { Logger } from "../../../core/Logger.js";
import type { EventBus } from "../../../core/EventBus.js";
import type { AuthCredentials } from "../../../core/auth.js";
import type { BrowserContext } from "playwright";

export interface INetflixModuleContext {
    logger: Logger;
    eventBus: EventBus;
    instanceId: string;
    apiBaseUrl: string;
    authCredentials: AuthCredentials;
    
    sleep(ms: number): Promise<void>;
    getOrCreateContext(contextName?: string, options?: { blockAssets?: boolean }): Promise<BrowserContext>;
    waitForTaskEvent<T>(taskId: string, eventName: string): Promise<T>;
    saveSession(contextName?: string, force?: boolean): Promise<void>;
    invalidateContext(contextName?: string): void;
    getContextByName(contextName: string): BrowserContext | null;
}
