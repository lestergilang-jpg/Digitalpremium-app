/**
 * Browser utilities for Playwright
 */

import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDataRoot } from './path.js';

// Default launch options
const DEFAULT_LAUNCH_OPTIONS: LaunchOptions = {
    headless: false,
    channel: 'chrome',
    args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
    ],
};

/**
 * Launch a new browser instance
 */
export async function launchBrowser(options?: LaunchOptions): Promise<Browser> {
    const mergedOptions = { ...DEFAULT_LAUNCH_OPTIONS, ...options };
    return chromium.launch(mergedOptions);
}

/**
 * Create a new browser context with optional storage state
 */
export async function createContext(
    browser: Browser,
    storageState?: any,
    options?: { blockAssets?: boolean }
): Promise<BrowserContext> {
    const contextOptions: Parameters<Browser['newContext']>[0] = {
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
    };

    // Load storage state if exists
    if (storageState) {
        if (typeof storageState === 'string' && existsSync(storageState)) {
            contextOptions.storageState = storageState;
        } else if (typeof storageState === 'object') {
            contextOptions.storageState = storageState;
        }
    }

    const context = await browser.newContext(contextOptions);

    if (options?.blockAssets) {
        await context.route('**/*', (route) => {
            const request = route.request();
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                route.abort();
            } else {
                route.continue();
            }
        });
    }

    return context;
}

/**
 * Save storage state (cookies, localStorage) to memory or file
 */
export async function saveStorageState(
    context: BrowserContext,
    path?: string
): Promise<any> {
    const state = await context.storageState();
    
    // If a path is provided, save to file as well
    if (path) {
        const dir = dirname(path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        await context.storageState({ path });
    }
    
    return state;
}

/**
 * Get storage state path for a module instance and context
 * @param instanceId - Module instance ID
 * @param contextName - Context name (default: 'default')
 */
export function getStorageStatePath(instanceId: string, contextName: string = 'default'): string {
    const filename = contextName === 'default'
        ? `${instanceId}.json`
        : `${instanceId}_${contextName}.json`;
    return resolve(getDataRoot(), 'session_data', filename);
}

/**
 * Close browser gracefully
 */
export async function closeBrowser(browser: Browser): Promise<void> {
    try {
        await browser.close();
    } catch {
        // Ignore close errors
    }
}

/**
 * Close context gracefully  
 */
export async function closeContext(context: BrowserContext): Promise<void> {
    try {
        await context.close();
    } catch {
        // Ignore close errors
    }
}

// ==========================================================================
// Global Browser Singleton with Auto-Restart
// ==========================================================================

let globalBrowser: Browser | null = null;
let lastLaunchOptions: LaunchOptions = {};

export function configureBrowserLaunchOptions(options: LaunchOptions): void {
    lastLaunchOptions = { ...lastLaunchOptions, ...options };
}

// Auto-restart state
let isIntentionalClose = false;
let isRestarting = false;
let restartAttempts = 0;

// Callbacks
type BrowserCallback = () => void;
const disconnectCallbacks: BrowserCallback[] = [];
const readyCallbacks: BrowserCallback[] = [];

// Promise for waiters
let browserReadyPromise: Promise<Browser> | null = null;
let browserReadyResolve: ((browser: Browser) => void) | null = null;

/**
 * Calculate backoff delay with exponential growth (max 16s)
 */
function getBackoffDelay(): number {
    const baseDelay = 1000;
    const maxDelay = 16000;
    return Math.min(baseDelay * Math.pow(2, restartAttempts), maxDelay);
}

/**
 * Handle browser disconnect event
 */
async function handleBrowserDisconnect(): Promise<void> {
    // Ignore if intentional close
    if (isIntentionalClose) {
        return;
    }

    // Prevent concurrent restarts
    if (isRestarting) {
        return;
    }

    isRestarting = true;
    globalBrowser = null;

    // Notify disconnect listeners
    disconnectCallbacks.forEach(cb => {
        try { cb(); } catch { /* ignore */ }
    });

    // Setup promise for waiters
    browserReadyPromise = new Promise(resolve => {
        browserReadyResolve = resolve;
    });

    // Exponential backoff restart
    const delay = getBackoffDelay();
    console.warn(`[browser] Browser disconnected, restarting in ${delay}ms (attempt ${restartAttempts + 1})...`);

    await new Promise(r => setTimeout(r, delay));
    restartAttempts++;

    try {
        const mergedOptions = { ...DEFAULT_LAUNCH_OPTIONS, ...lastLaunchOptions };
        globalBrowser = await chromium.launch(mergedOptions);

        // Register disconnect handler for new browser
        globalBrowser.on('disconnected', () => {
            handleBrowserDisconnect();
        });

        // Reset state on success
        restartAttempts = 0;
        isRestarting = false;

        console.info('[browser] Browser restarted successfully');

        // Notify ready listeners
        readyCallbacks.forEach(cb => {
            try { cb(); } catch { /* ignore */ }
        });

        // Resolve promise for waiters
        if (browserReadyResolve && globalBrowser) {
            browserReadyResolve(globalBrowser);
            browserReadyPromise = null;
            browserReadyResolve = null;
        }
    } catch (err) {
        isRestarting = false;
        console.error(`[browser] Failed to restart browser: ${err instanceof Error ? err.message : 'Unknown'}`);
        // Will retry on next getGlobalBrowser call
    }
}

/**
 * Get or launch the global browser instance (lazy initialization)
 */
export async function getGlobalBrowser(options?: LaunchOptions): Promise<Browser> {
    // If currently restarting, wait for it
    if (isRestarting && browserReadyPromise) {
        return browserReadyPromise;
    }

    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }

    // Save options for restart
    if (options) {
        configureBrowserLaunchOptions(options);
    }

    // Launch new global browser
    const mergedOptions = { ...DEFAULT_LAUNCH_OPTIONS, ...lastLaunchOptions };
    globalBrowser = await chromium.launch(mergedOptions);

    // Register disconnect handler
    globalBrowser.on('disconnected', () => {
        handleBrowserDisconnect();
    });

    restartAttempts = 0;
    return globalBrowser;
}

/**
 * Close the global browser instance (for graceful shutdown)
 */
export async function closeGlobalBrowser(): Promise<void> {
    isIntentionalClose = true;

    if (globalBrowser) {
        try {
            await globalBrowser.close();
        } catch {
            // Ignore close errors
        }
        globalBrowser = null;
    }

    // Reset state
    isIntentionalClose = false;
    isRestarting = false;
    restartAttempts = 0;
    browserReadyPromise = null;
    browserReadyResolve = null;
    disconnectCallbacks.length = 0;
    readyCallbacks.length = 0;
}

/**
 * Recycle global browser (close all contexts, close browser, relaunch)
 * Used by TaskManager for scheduled browser recycling
 */
export async function recycleGlobalBrowser(): Promise<Browser> {
    if (!globalBrowser) {
        return getGlobalBrowser();
    }

    // Close all contexts first
    const contexts = globalBrowser.contexts();
    for (const ctx of contexts) {
        try {
            await ctx.close();
        } catch { /* ignore */ }
    }

    // Close browser
    isIntentionalClose = true;
    try {
        await globalBrowser.close();
    } catch { /* ignore */ }
    globalBrowser = null;
    isIntentionalClose = false;

    // Wait a bit before relaunching
    await new Promise(r => setTimeout(r, 2000));

    // Relaunch and return new browser
    return getGlobalBrowser();
}

/**
 * Check if global browser is available and connected
 */
export function isGlobalBrowserConnected(): boolean {
    return globalBrowser !== null && globalBrowser.isConnected() && !isRestarting;
}

/**
 * Register callback for browser disconnect event
 */
export function onBrowserDisconnect(callback: BrowserCallback): void {
    disconnectCallbacks.push(callback);
}

/**
 * Register callback for browser ready event (after restart)
 */
export function onBrowserReady(callback: BrowserCallback): void {
    readyCallbacks.push(callback);
}

/**
 * Wait for browser to be ready (blocks during restart)
 */
export async function waitForBrowserReady(): Promise<Browser> {
    if (browserReadyPromise) {
        return browserReadyPromise;
    }
    return getGlobalBrowser();
}
