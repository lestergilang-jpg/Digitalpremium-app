/**
 * DuokeModule - Module for auto-replying messages in Duoke Chat
 */

import { Page } from 'playwright';
import { BaseModule } from '../../core/BaseModule.js';
import { ModuleDependencies } from '../../types/module.type.js';
import { ModuleConfig } from '../../types/config.type.js';
import { DuokeConfig, DuokeHistory } from './types.js';
import * as locators from './locators.js';
import { resolve } from 'node:path';
import { getProjectRoot } from '../../utils/path.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { GeminiChatService, GenerateReplyResult } from './GeminiChatService.js';
import { OllamaChatService } from './OllamaChatService.js';

interface DuokeChatService {
    callBackendNetflixToken?(buyerName?: string, orderId?: string): Promise<any>;
    generateReply(params: {
        username: string;
        orderId?: string;
        orderStatus?: string;
        chatHistory: locators.ChatMessage[];
        accountInfo?: any;
    }): Promise<GenerateReplyResult>;
}

const CHAT_URL = 'https://ai.duoke.com/?lang=en#/dk/main/chat';
const DEFAULT_CHECK_INTERVAL = 30000;

export class DuokeModule extends BaseModule {
    private duokeConfig: DuokeConfig;
    private loopPage: Page | null = null;
    private historyPath: string;
    private loopCount: number = 0; // Tambahkan counter untuk refresh
    private aiService: DuokeChatService | null = null;
    private escalatedUsers: Map<string, number> = new Map(); // username -> escalated timestamp (ms)
    private lastRepliedTextPerUser: Map<string, string> = new Map(); // username -> last replied buyer message

    constructor(deps: ModuleDependencies, instanceId: string, config: ModuleConfig) {
        super(deps, instanceId, config);
        this.duokeConfig = config as unknown as DuokeConfig;
        this.historyPath = resolve(getProjectRoot(), 'storage', `duoke_history_${this.instanceId}.json`);

        const provider = this.duokeConfig.ai_provider || (this.duokeConfig.ollama_model ? 'ollama' : 'gemini');
        const geminiApiKey = process.env.GEMINI_API_KEY || this.duokeConfig.gemini_api_key;

        if (provider === 'ollama') {
            const ollamaModel = this.duokeConfig.ollama_model || 'qwen2.5:7b';
            const ollamaBaseUrl = this.duokeConfig.ollama_base_url || 'http://127.0.0.1:11434';
            this.aiService = new OllamaChatService({
                baseUrl: ollamaBaseUrl,
                model: ollamaModel,
                sopFilePath: this.duokeConfig.sop_file_path || 'sop_duoke.md',
                apiBaseUrl: this.apiBaseUrl,
                authCredentials: this.authCredentials,
                logger: this.logger,
            });
            this.logger.info(`DuokeModule: Ollama Local AI Auto-Reply AKTIF (model: ${ollamaModel}, url: ${ollamaBaseUrl})`);
        } else if (geminiApiKey) {
            this.aiService = new GeminiChatService({
                apiKey: geminiApiKey,
                model: this.duokeConfig.gemini_model || 'gemini-3.8-flash',
                sopFilePath: this.duokeConfig.sop_file_path || 'sop_duoke.md',
                apiBaseUrl: this.apiBaseUrl,
                authCredentials: this.authCredentials,
                logger: this.logger,
            });
            this.logger.info(`DuokeModule: Gemini AI Auto-Reply AKTIF (model: ${this.duokeConfig.gemini_model || 'gemini-3.8-flash'})`);
        } else {
            this.logger.info('DuokeModule: AI tidak terkonfigurasi, berjalan dalam mode balasan statis.');
        }
    }

    async setupSchema(): Promise<void> {
        // No specific DB tables needed, using JSON as requested or KV store
        this.logger.info('DuokeModule schema setup skipped (using JSON storage)');
    }

    async init(): Promise<void> {
        this.setRunning(true);
        this.logger.info('DuokeModule initialized');
    }

    async stop(): Promise<void> {
        await this.cleanup();
        this.loopPage = null;
        this.logger.info('DuokeModule stopped');
    }

    /**
     * Main loop called by TaskManager
     */
    async executeLoop(): Promise<void> {
        try {
            const context = await this.getOrCreateContext('duoke_session', { blockAssets: false });
            
            if (!this.loopPage || this.loopPage.isClosed()) {
                this.loopPage = await context.newPage();
            }

            if (this.loopPage.url() === 'about:blank' || !this.loopPage.url().includes('duoke.com')) {
                await this.loopPage.goto(CHAT_URL);
                await this.sleep(5000);
            }

            // Auto Refresh setiap 300 putaran (Sekitar 10 menit jika loop 2 detik)
            this.loopCount++;
            if (this.loopCount >= 300) {
                this.logger.info('Refreshing Duoke page to keep connection fresh...');
                await this.loopPage.reload();
                await this.sleep(8000); // Tunggu loading setelah reload lebih lama sedikit agar stabil
                this.loopCount = 0;
            }

            // 1. Check Login
            const isLoginPage = await this.checkIsLoginPage();
            if (isLoginPage) {
                this.logger.warn('⚠️ Belum Login Duoke. Silahkan login manual di browser bot!', {
                    instanceId: this.instanceId
                });
                await this.sleep(60000); // Wait 1 minute before checking again
                return;
            }

            // 2. Auto-save session once logged in
            await this.saveSession('duoke_session');

            // 3. Scan for unread messages
            await this.scanAndReply();

        } catch (error) {
            this.logger.error(`Error in Duoke loop: ${error instanceof Error ? error.message : String(error)}`);
            await this.sleep(5000);
        }
    }

    private async checkIsLoginPage(): Promise<boolean> {
        if (!this.loopPage) return false;
        try {
            // Check for email input or login button
            const loginVisible = await locators.getEmailInput(this.loopPage).isVisible({ timeout: 2000 });
            return loginVisible;
        } catch {
            return false;
        }
    }

    private async scanAndReply(): Promise<void> {
        if (!this.loopPage) return;

        // Ambil daftar user yang sudah dibalas hari ini dari DB
        const repliedUsers = this.getRepliedUsers();

        // Tutup popup jika muncul
        try {
            const closeBtn = locators.getClosePopupButton(this.loopPage);
            if (await closeBtn.isVisible()) {
                await closeBtn.click();
                await this.sleep(1000); // Tunggu animasi tutup popup
            }
        } catch (e) {
            this.logger.debug('Gagal tutup popup atau tidak ada popup: ' + e);
        }

        // Cari semua kontainer chat yang punya badge unread DAN nama pembeli
        const chatItems = await locators.getChatItem(this.loopPage).all();
        
        if (chatItems.length === 0) {
            this.logger.debug('No valid unread chats found');
            return;
        }

        // Kumpulkan user unik untuk diproses agar tidak log dobel
        const uniqueUsersToProcess: Map<string, typeof chatItems[0]> = new Map();
        
        for (const item of chatItems) {
            try {
                const buyerElement = item.locator('div.buyer_name, [class*="buyer_name"], [class*="buyerName"]').first();
                if (!await buyerElement.isVisible()) continue;
                
                const username = (await buyerElement.innerText()).trim().toLowerCase();
                if (username && !uniqueUsersToProcess.has(username)) {
                    uniqueUsersToProcess.set(username, item);
                }
            } catch (err) {
                // Ignore silent error during collection
            }
        }

        // Proses setiap user unik
        for (const [username, item] of uniqueUsersToProcess.entries()) {
            try {
                // Cek apakah user sedang dalam masa eskalasi ke admin (timeout 2 jam)
                const ESCALATION_TTL_MS = 2 * 60 * 60 * 1000;
                const escalatedAt = this.escalatedUsers.get(username);
                if (escalatedAt) {
                    if (Date.now() - escalatedAt < ESCALATION_TTL_MS) {
                        const remainingMinutes = Math.round((ESCALATION_TTL_MS - (Date.now() - escalatedAt)) / 60000);
                        this.logger.info(`Skipping ${username}: percakapan sudah dieskalasikan ke admin manusia (${remainingMinutes} menit tersisa)`);
                        continue;
                    } else {
                        this.escalatedUsers.delete(username);
                        this.logger.info(`Eskalasi untuk ${username} telah berakhir (> 2 jam). AI kembali aktif untuk pembeli ini.`);
                    }
                }

                // Cek apakah sudah dibalas hari ini (hanya jika mode statis)
                const isAiActive = this.aiService && this.duokeConfig.ai_reply_enabled !== false;
                if (!isAiActive && repliedUsers.includes(username)) {
                    this.logger.info(`Skipping ${username}: already replied today (mode statis)`);
                    continue;
                }

                // Double check spesifik ke badge sup
                const badge = item.locator('sup.dk-badge__content.is-fixed:visible, sup.el-badge__content.is-fixed:visible, sup[class*="-badge__content"].is-fixed:visible').first();
                if (!await badge.isVisible()) continue;
 
                 this.logger.info(`Processing unread message from: ${username}`);
 
                 // Klik LANGSUNG pada nama pembeli
                 await item.locator('div.buyer_name, [class*="buyer_name"], [class*="buyerName"]').first().click({ force: true });

                const textarea = locators.getChatTextarea(this.loopPage);
                try {
                    await textarea.waitFor({ state: 'visible', timeout: 8000 });
                } catch (e) {
                    this.logger.warn(`Textarea still not visible for ${username}, moving to next`);
                    continue;
                }

                if (await textarea.isVisible()) {
                    let isReadyToShip = false;
                    let isUnpaid = false;
                    let isShipped = false;
                    let shippedCategory = '';
                    let shippedExpired = false;
                    let orderId = '';
                    
                    try {
                        const orderTab = locators.getOrderTab(this.loopPage);
                        if (await orderTab.isVisible()) {
                            const isTabActive = await orderTab.evaluate(el => el.classList.contains('is-active'));
                            if (!isTabActive) {
                                await orderTab.click();
                                await this.sleep(1000);
                            }
                            
                            // [DEBUG] Tunggu sebentar sampai tag apa pun muncul di pane-order (maksimal 3 detik)
                            try {
                                await this.loopPage.waitForSelector('#pane-order [class*="tag"]', { state: 'visible', timeout: 3000 });
                            } catch (e) {
                                this.logger.debug('[DEBUG] Timeout: Tidak ada tag yang muncul di #pane-order dalam 3 detik.');
                            }

                            // Cek Order ID jika ada
                            try {
                                const orderIdLoc = locators.getOrderId(this.loopPage);
                                if (await orderIdLoc.isVisible()) {
                                    orderId = (await orderIdLoc.innerText()).trim();
                                    this.logger.info(`[Duoke] Terdeteksi Order ID: ${orderId} untuk ${username}`);
                                }
                            } catch (e) {}

                            // [DEBUG] Cetak semua tag yang ditemukan
                            const allTags = await this.loopPage.locator('#pane-order [class*="tag"]').allInnerTexts();
                            this.logger.info(`[DEBUG] Tag yang terdeteksi di panel Order untuk ${username}: ${JSON.stringify(allTags)}`);
                            
                            const readyToShipTag = locators.getReadyToShipTag(this.loopPage);
                            const unpaidTag = locators.getUnpaidTag(this.loopPage);
                            const shippedTag = locators.getShippedTag(this.loopPage);
                            
                            if (await readyToShipTag.isVisible()) {
                                isReadyToShip = true;
                            } else if (await unpaidTag.isVisible()) {
                                isUnpaid = true;
                            } else if (await shippedTag.isVisible()) {
                                isShipped = true;
                                const amountLoc = locators.getPaymentAmount(this.loopPage);
                                const timeLoc = locators.getPaymentTime(this.loopPage);
                                
                                if (await amountLoc.isVisible() && await timeLoc.isVisible()) {
                                    const amountText = await amountLoc.innerText();
                                    const timeText = await timeLoc.innerText();
                                    
                                    const priceMatch = amountText.replace(/,/g, '').match(/\d+/);
                                    const price = priceMatch ? parseInt(priceMatch[0], 10) : 0;
                                    
                                    if (price < 15000) shippedCategory = 'harian';
                                    else if (price <= 30000) shippedCategory = 'mingguan';
                                    else if (price <= 45000) shippedCategory = 'sharing_bulanan';
                                    else shippedCategory = 'bulanan';
                                    
                                    const timeStrMatch = timeText.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2})/);
                                    if (timeStrMatch) {
                                        const orderDateStr = timeStrMatch[1].replace(/\//g, '-').replace(' ', 'T') + ':00+07:00';
                                        const orderDate = new Date(orderDateStr);
                                        const now = new Date();
                                        const diffMs = now.getTime() - orderDate.getTime();
                                        const diffHours = diffMs / (1000 * 60 * 60);
                                        const diffDays = diffHours / 24;
                                        
                                        if (shippedCategory === 'harian' && diffHours > 22) shippedExpired = true;
                                        if (shippedCategory === 'mingguan' && diffDays > 7) shippedExpired = true;
                                        if (shippedCategory === 'sharing_bulanan' && diffDays > 25) shippedExpired = true;
                                        if (shippedCategory === 'bulanan' && diffDays > 25) shippedExpired = true;
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        this.logger.debug('Gagal cek status order: ' + err);
                    }

                    let finalReply = '';
                    let lastRepliedBuyerText = '';

                    // 1. Coba Balasan via AI jika diaktifkan
                    if (isAiActive && this.aiService) {
                        const debounceSec = this.duokeConfig.ai_debounce_seconds ?? 4;
                        if (debounceSec > 0) {
                            this.logger.info(`Menunggu debounce ${debounceSec} detik untuk ${username}...`);
                            await this.sleep(debounceSec * 1000);
                        }

                        // Ekstraksi riwayat chat terbaru
                        const chatHistory = await locators.extractRecentChatMessages(this.loopPage, 6);
                        this.logger.info(`[DEBUG] chatHistory untuk ${username}: ${chatHistory.length} pesan ditemukan. ${chatHistory.length > 0 ? JSON.stringify(chatHistory.slice(-2)) : 'KOSONG'}`);
                        // Cek apakah pesan terakhir dikirim oleh toko sendiri (hindari membalas diri sendiri)
                        if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].sender === 'seller') {
                            this.logger.info(`Pesan terakhir untuk ${username} sudah dikirim oleh penjual. Melewati.`);
                            continue;
                        }

                        // Cek pesan terakhir pembeli untuk menghindari pengulangan balasan pada pesan yang sama
                        const lastBuyerMsg = [...chatHistory].reverse().find(m => m.sender === 'buyer');
                        if (lastBuyerMsg) {
                            const rawBuyerText = lastBuyerMsg.text.trim();
                            if (this.lastRepliedTextPerUser.get(username) === rawBuyerText) {
                                this.logger.info(`[DuokeModule] Pesan buyer terakhir dari ${username} ("${rawBuyerText}") sudah pernah dibalas. Melewati.`);
                                continue;
                            }
                            lastRepliedBuyerText = rawBuyerText;
                        }

                        // Deteksi respon cepat / Mirroring untuk chat pendek (Ok, Makasih, dsb) tanpa panggil AI/database
                        let isMirroringHandled = false;
                        if (lastBuyerMsg) {
                            const clean = lastBuyerMsg.text.trim().toLowerCase().replace(/[.!?~,]/g, '').trim();

                            // 1. Terima kasih / Thanks
                            const isThankYou = /^(makasih|makasi|terima\s*kasih|terimakasih|thanks|thank\s*you|thx|tq|tengkyu|suwun|maturnuwun)(\s+(kak|ya|min|banyak))*$/i.test(clean);

                            // 2. Konfirmasi / Balasan Pendek ("ok", "siap", "baik", dsb)
                            const isAck = /^(ok|oke|okee|okey|okay|siap|siaap|baik|baiklah|noted|sip|sipp|mantap|yoi|yoii|siap\s*kak|oke\s*kak|ok\s*kak)(\s+(kak|ya|min))*$/i.test(clean);

                            if (isThankYou) {
                                finalReply = 'Iya kak sama-sama ya kak 😊';
                                this.logger.info(`[DuokeModule] Terdeteksi ucapan terima kasih dari ${username} ("${lastBuyerMsg.text}"). Balas mirroring: "${finalReply}"`);
                                isMirroringHandled = true;
                            } else if (isAck) {
                                const ackReplies = ['Baik kak 😊', 'Siap kak 😊', 'Oke kak 😊'];
                                finalReply = ackReplies[Math.floor(Math.random() * ackReplies.length)];
                                this.logger.info(`[DuokeModule] Terdeteksi konfirmasi pendek/OK dari ${username} ("${lastBuyerMsg.text}"). Balas mirroring: "${finalReply}"`);
                                isMirroringHandled = true;
                            }
                        }

                        if (!isMirroringHandled) {
                            // Ekstraksi kode voucher atau nomor pesanan dari riwayat chat pembeli jika ada
                            let chatDetectedOrder = '';
                            for (let i = chatHistory.length - 1; i >= 0; i--) {
                                const msg = chatHistory[i];
                                if (msg.sender === 'buyer') {
                                    const matches = msg.text.match(/VC-[A-Z0-9]+/gi) || [];
                                    for (const m of matches) {
                                        // Abaikan teks contoh seperti "VC-xxx" atau "VC-XXX"
                                        if (!/^VC-X+$/i.test(m)) {
                                            chatDetectedOrder = m.toUpperCase();
                                            this.logger.info(`[DuokeModule] Terdeteksi kode voucher di chat untuk ${username}: ${chatDetectedOrder}`);
                                            break;
                                        }
                                    }
                                    if (chatDetectedOrder) break;
                                }
                            }
                            const effectiveOrderId = chatDetectedOrder || orderId || undefined;

                            let orderStatusDesc = 'Tidak diketahui';
                            if (isReadyToShip) orderStatusDesc = 'Ready to Ship (Pesanan sudah dibayar, sedang diproses)';
                            else if (isUnpaid) orderStatusDesc = 'Unpaid (Pesanan belum dibayar)';
                            else if (isShipped) orderStatusDesc = `Shipped (Kategori di panel: ${shippedCategory || 'umum'})`;

                            // Identifikasi pembeli & transaksi terakhir di database kita (digitalpremium.id/dashboard/transaction)
                            let accountInfo: any = null;
                            if (typeof this.aiService.callBackendNetflixToken === 'function') {
                                try {
                                    this.logger.info(`[DuokeModule] Mengidentifikasi username di database transaksi untuk buyer: ${username}, orderId/voucher: ${effectiveOrderId || 'none'}...`);
                                    accountInfo = await this.aiService.callBackendNetflixToken(username, effectiveOrderId);
                                    this.logger.info(`[DuokeModule] Hasil identifikasi database untuk ${username}: ${JSON.stringify(accountInfo)}`);
                                } catch (err: any) {
                                    this.logger.warn(`[DuokeModule] Gagal cek database transaksi: ${err.message}`);
                                }
                            }

                            this.logger.info(`Meminta AI (${this.duokeConfig.ai_provider || 'ai'}) menyusun balasan untuk ${username}...`);
                            const aiResult = await this.aiService.generateReply({
                                username,
                                orderId: effectiveOrderId,
                                orderStatus: orderStatusDesc,
                                chatHistory,
                                accountInfo,
                            });

                            if (aiResult.escalated) {
                                this.escalatedUsers.set(username, Date.now());
                                this.logger.warn(`User ${username} dialihkan ke eskalasi admin manusia (selama 2 jam).`);
                            }

                            finalReply = aiResult.replyText;
                        }
                    } else {
                        // 2. Fallback ke Balasan Statis
                        const defaultReply = process.env.REPLY_LINES || this.duokeConfig.reply_lines || 'Ready kak Silahkan Order';
                        const readyToShipReply = process.env.REPLY_READY_TO_SHIP || this.duokeConfig.reply_ready_to_ship || 'Pesanan kakak sudah kami terima dan sedang kami proses. Mohon ditunggu sebentar ya';
                        const unpaidReply = process.env.REPLY_UNPAID || this.duokeConfig.reply_unpaid || 'Segara selesaikan payment dan akan kami proses secepatnya kak 😊';

                        finalReply = defaultReply;
                        if (isReadyToShip) {
                            finalReply = readyToShipReply;
                            this.logger.info(`Status "Ready to Ship" DITEMUKAN untuk ${username}, membalas dengan reply_ready_to_ship`);
                        } else if (isUnpaid) {
                            finalReply = unpaidReply;
                            this.logger.info(`Status "Unpaid" DITEMUKAN untuk ${username}, membalas dengan reply_unpaid`);
                        } else if (isShipped) {
                            if (shippedCategory === 'harian') {
                                finalReply = shippedExpired ? (this.duokeConfig.Shipped_reply_habis_harian || '') : (this.duokeConfig.Shipped_reply_harian || '');
                            } else if (shippedCategory === 'mingguan') {
                                finalReply = shippedExpired ? (this.duokeConfig.Shipped_reply_habis_mingguan || '') : (this.duokeConfig.Shipped_reply_mingguan || '');
                            } else if (shippedCategory === 'sharing_bulanan') {
                                finalReply = shippedExpired ? (this.duokeConfig.Shipped_reply_habis_sharing_bulanan || '') : (this.duokeConfig.Shipped_reply_sharing_bulanan || '');
                            } else if (shippedCategory === 'bulanan') {
                                finalReply = shippedExpired ? (this.duokeConfig.Shipped_reply_habis_bulanan || '') : (this.duokeConfig.Shipped_reply_bulanan || '');
                            }

                            if (!finalReply) finalReply = defaultReply;
                            this.logger.info(`Status "Shipped" DITEMUKAN untuk ${username} (${shippedCategory}, expired: ${shippedExpired}), membalas dengan custom shipped reply`);
                        } else {
                            this.logger.info(`Status khusus TIDAK DITEMUKAN untuk ${username}, membalas dengan reply_lines reguler`);
                        }
                    }

                    const replyLines = finalReply
                        .split('||')
                        .map(s => s.trim());

                    // Mencoba mencari kolom input yang BENAR-BENAR terlihat di layar
                    // Bisa jadi textarea biasa, atau contenteditable div
                    const inputBox = this.loopPage.locator('textarea:visible, [contenteditable="true"]:visible, [placeholder*="quick reply"]').first();
                    
                    if (await inputBox.isVisible()) {
                        // 1. Klik kolom input agar fokus
                        await inputBox.click({ force: true });
                        await this.sleep(500);

                        for (const line of replyLines) {
                            // Kosongkan kolom input terlebih dahulu untuk mencegah sisa teks
                            await this.loopPage.keyboard.press('Control+A');
                            await this.loopPage.keyboard.press('Backspace');
                            await this.sleep(300);

                            // 2. Auto-fill langsung dengan jeda 1 detik
                            await inputBox.fill(line);
                            await this.sleep(1000); // Delay 1 detik sesuai permintaan
                            
                            // 3. Tekan Enter untuk mengirim
                            await this.loopPage.keyboard.press('Enter');
                            await this.sleep(1000); // Jeda tambahan setelah mengirim
                        }

                        // 4. Klik tombol Send berwarna biru (Kirim) jika Enter tidak berfungsi
                        try {
                            const sendBtn = locators.getSendButton(this.loopPage);
                            if (await sendBtn.isVisible()) {
                                await sendBtn.click();
                                await this.sleep(500);
                            }
                        } catch (e) {
                            this.logger.debug('Tidak dapat mengeklik tombol Send biru: ' + e);
                        }

                        try {
                            if (lastRepliedBuyerText) {
                                this.lastRepliedTextPerUser.set(username, lastRepliedBuyerText);
                            }
                            this.saveRepliedUser(username);
                            repliedUsers.push(username); 
                            this.logger.info(`Successfully replied to ${username}`);
                        } catch (dbError) {
                            this.logger.error(`Failed to save history for ${username}: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
                        }
                        
                        // Selesai membalas 1 pembeli, break loop agar putaran loop berikutnya (2s) membaca daftar chat terbaru
                        break;
                    } else {
                        this.logger.warn(`Kolom input chat tidak terlihat untuk ${username}, pesan tidak dapat dikirim.`);
                    }
                } // Menutup if (await textarea.isVisible())

            } catch (error) {
                this.logger.error(`Failed to process ${username}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private getRepliedUsers(): string[] {
        const key = `duoke_replied_${this.instanceId}`;
        try {
            const row = this.db.get<{ value: string }>('SELECT value FROM sys_kv_store WHERE key = ?', [key]);
            if (!row) return [];
            
            const data = JSON.parse(row.value);
            const today = new Date().toISOString().split('T')[0];
            
            if (data.date !== today) return [];
            return data.users || [];
        } catch (error) {
            this.logger.error(`Error reading replied users from DB: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    private saveRepliedUser(username: string): void {
        const key = `duoke_replied_${this.instanceId}`;
        const users = this.getRepliedUsers();
        
        if (!users.includes(username)) {
            users.push(username);
        }

        const today = new Date().toISOString().split('T')[0];
        const data = JSON.stringify({
            date: today,
            users: users
        });

        // FIX: Gunakan datetime('now') dengan single quotes untuk SQLite
        this.db.run(
            'INSERT INTO sys_kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = datetime(\'now\')',
            [key, data]
        );
    }
}
