/**
 * GeminiChatService - AI Agent service powered by Google Gemini for Duoke Auto-Reply
 */

import { GoogleGenAI } from '@google/genai';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProjectRoot } from '../../utils/path.js';
import type { Logger } from '../../core/Logger.js';
import type { AuthCredentials } from '../../core/auth.js';
import { authHeaders } from '../../core/auth.js';
import type { ChatMessage } from './locators.js';

export interface GeminiServiceOptions {
    apiKey: string;
    model?: string;
    sopFilePath?: string;
    apiBaseUrl: string;
    authCredentials: AuthCredentials;
    logger: Logger;
}

export interface GenerateReplyResult {
    replyText: string;
    escalated: boolean;
    toolUsed?: string;
}

export class GeminiChatService {
    private apiKeys: string[] = [];
    private currentKeyIndex: number = 0;
    private aiClients: GoogleGenAI[] = [];
    private model: string;
    private sopContent: string = '';
    private apiBaseUrl: string;
    private authCredentials: AuthCredentials;
    private logger: Logger;

    constructor(options: GeminiServiceOptions) {
        // Mendukung multiple API key yang dipisahkan dengan koma (key1,key2,key3)
        const rawKeys = options.apiKey ? options.apiKey.split(',') : [];
        this.apiKeys = rawKeys.map(k => k.trim()).filter(Boolean);
        if (this.apiKeys.length === 0) {
            throw new Error('GeminiChatService: Minimal 1 gemini_api_key harus disediakan!');
        }

        this.aiClients = this.apiKeys.map(key => new GoogleGenAI({ apiKey: key }));
        this.model = options.model || 'gemini-3.8-flash';
        this.apiBaseUrl = options.apiBaseUrl.startsWith('http') ? options.apiBaseUrl : `http://${options.apiBaseUrl}`;
        this.authCredentials = options.authCredentials;
        this.logger = options.logger;

        this.logger.info(`GeminiChatService: Terdeteksi ${this.apiKeys.length} Gemini API Key (Multi-Key Auto-Rotation Aktif).`);
        this.loadSop(options.sopFilePath);
    }

    private get ai(): GoogleGenAI {
        return this.aiClients[this.currentKeyIndex];
    }

    /**
     * Beralih ke API Key berikutnya jika kuota saat ini habis (429)
     */
    private rotateApiKey(reason?: string): boolean {
        if (this.currentKeyIndex < this.apiKeys.length - 1) {
            this.currentKeyIndex++;
            this.logger.warn(`[GeminiChatService] Beralih otomatis ke Gemini API Key #${this.currentKeyIndex + 1} dari ${this.apiKeys.length} (${reason || 'Rotasi Key'}).`);
            return true;
        }
        return false;
    }

    private loadSop(customPath?: string): void {
        const root = getProjectRoot();
        const candidatePaths = [
            customPath ? resolve(root, customPath) : null,
            resolve(root, 'sop_duoke.md'),
            resolve(root, 'apps', 'bot2', 'sop_duoke.md'),
        ].filter(Boolean) as string[];

        for (const p of candidatePaths) {
            if (existsSync(p)) {
                try {
                    this.sopContent = readFileSync(p, 'utf-8');
                    this.logger.info(`GeminiChatService: SOP loaded from ${p}`);
                    return;
                } catch (e) {
                    this.logger.warn(`GeminiChatService: Gagal membaca SOP di ${p}: ${e}`);
                }
            }
        }

        this.logger.warn('GeminiChatService: File SOP tidak ditemukan, menggunakan SOP default.');
        this.sopContent = 'Berikan pelayanan ramah sebagai CS Volve Store, sapaan Kak, jawab ringkas dan solutif.';
    }

    private buildSystemInstruction(): string {
        return `Kamu adalah Customer Service resmi dari Volve Store di live chat marketplace.
Nama kamu adalah Dara. Balas dengan bahasa Indonesia yang sopan, ramah, dan SANGAT SINGKAT (MAKSIMAL 2 KALIMAT).

ATURAN KOMUNIKASI & ANTI-BANNED SHOPEE (SANGAT KETAT):
1. Sapaan: selalu panggil pembeli dengan "Kak".
2. PANJANG BALASAN: MAKSIMAL 2 KALIMAT SAJA. Padat, solutif, jangan bertele-tele.
3. DILARANG KERAS mengetik kata "WhatsApp", "WA", "whatsapp", "wa", atau nomor HP karena sistem Shopee akan memblokir toko!
4. DILARANG KERAS menyertakan awalan "https://" atau "http://" dan DILARANG memakai format markdown seperti [link](url). Tulis link polos: paytronik.digitalpremium.id/product atau s.id/LangganandiWea
5. Jika menginfokan order di luar Shopee atau perpanjang paket, HANYA gunakan kata samaran "kewa" atau arahkan ke web resmi toko:
   Contoh: "bisa order keweb kita dulu paytronik.digitalpremium.id/product atau kewa s.id/LangganandiWea ya kak 😊"
6. DILARANG menjanjikan refund atau pembatalan. Jika diminta refund / pembeli komplain keras, panggil tool 'escalate_to_human'.
7. DILARANG KERAS MENGARANG LINK LOGIN NETFLIX (seperti /l/loginhp, /l/xxx palsu, dsb)!
   - Link login Netflix HANYA dan WAJIB diambil persis dari properti 'pcLink', 'mobileLink', atau 'tvLink' yang diberikan di data database / tool!
   - JIKA tool/database TIDAK memberikan link (misal success=false atau isExpired=true), DILARANG MENYERTAKAN LINK APAPUN!
   - Jika pembeli butuh link login HP: berikan mobileLink yang tersedia.
   - Jika pembeli butuh link login Laptop/PC: berikan pcLink yang tersedia.
   - Jika pembeli butuh link login TV: berikan tvLink yang tersedia.

ATURAN MIRRORING DAN PESAN SINGKAT (SANGAT PENTING):
- Jika pembeli hanya mengirim pesan singkat, konfirmasi, atau ucapan:
  * Pembeli konfirmasi ("ok", "oke", "siap", "baik", "noted", "sip") -> Cukup balas mirroring singkat: "Baik kak 😊" atau "Siap kak 😊". DILARANG menanyakan nomor pesanan atau voucher!
  * Pembeli mengucapkan terima kasih ("makasih", "terima kasih", "thanks") -> Cukup balas: "Iya kak, sama-sama ya kak 😊". DILARANG menanyakan nomor pesanan atau voucher!
  * Pembeli hanya menyapa ("halo", "hai", "p") -> Cukup balas: "Halo kak, ada yang bisa kami bantu? 😊".
- PENTING: DILARANG KERAS menanyakan nomor pesanan Shopee atau kode voucher jika pembeli TIDAK sedang mengeluhkan kendala akun atau masalah login!

ATURAN IDENTIFIKASI TRANSAKSI DATABASE & FLOW JAWABAN:
Sistem selalu mengidentifikasi username pembeli di database transaksi (digitalpremium.id/dashboard/transaction) sebelum kamu membalas. Perhatikan bagian "DATA IDENTIFIKASI DATABASE TRANSAKSI":

A. JIKA DATA DATABASE: AKUN MEMILIKI DURASI AKTIF (hasActiveDuration=true / isExpired=false):
   - Akun pembeli ini MASIH AKTIF.
   - DILARANG KERAS mengatakan durasi habis atau menyuruh beli lagi!
   - JIKA PEMBELI MENGELUH KENDALA (akun gabisa dipakai / bentrok / keluar sendiri / minta link login):
     * JANGAN LANGSUNG lempar link sembarangan jika pembeli belum menyebutkan perangkat atau detail kendala!
     * LEMPAR PERTANYAAN KLARIFIKASI TERLEBIH DAHULU:
       "Gabisanya gimana kak? Login pakai TV, HP, atau Laptop?"
     * JIKA PEMBELI SUDAH MENYEBUTKAN PERANGKATNYA (misal: "laptop", "pc", "hp", atau "tv"):
       - Laptop/PC: berikan link pcLink yang tersedia di data (tulis polos tanpa https://).
       - HP/Mobile: berikan link mobileLink atau generalLink yang tersedia di data (tulis polos tanpa https://).
       - TV: berikan link tvLink dan infokan untuk dibuka di browser HP/PC yang satu Wi-Fi dengan TV lalu masukkan kode TV.

B. JIKA DATA DATABASE: MASA AKTIF SUDAH HABIS (isExpired=true):
   - Sampaikan dengan sopan dan jelaskan berdasarkan varian transaksi terakhirnya:
     Contoh: "Mohon maaf kak, setelah kami cek transaksi terakhir kakak untuk [Varian Produk], masa aktifnya sudah berakhir. Kakak bisa order keweb kita dulu paytronik.digitalpremium.id/product atau kewa s.id/LangganandiWea ya kak 😊"

C. JIKA DATA DATABASE: TIDAK DITEMUKAN (found=false atau success=false):
   - DILARANG mengklaim masa aktif habis!
   - DILARANG memberikan link login palsu!
   - HANYA TANYAKAN NOMOR PESANAN / KODE VOUCHER JIKA PEMBELI SEDANG MENGELUHKAN KENDALA (misal akun gabisa login, minta akun baru, komplain error, atau minta cek transaksi):
     Contoh: "Halo kak, boleh infokan nomor pesanan Shopee atau kode voucher (format VC-xxx) kakak? Biar kami bantu cek transaksinya ya kak 🙏"
   - JIKA PEMBELI TIDAK MENGELUHKAN KENDALA (misal tanya stok, tanya fitur, obrolan santai, atau konfirmasi):
     Jawab langsung percakapan pembeli secara ramah dan solutif tanpa menanyakan kode voucher!

D. JIKA PEMBELI HANYA TANYA STOK / READY:
   - Jawab ramah: "Ready kak, silakan langsung diorder ya 😊"

SOP TOKO:
${this.sopContent}
`;
    }

    /**
     * Sanitasi balasan AI agar mematuhi aturan Shopee:
     * - Menghilangkan awalan https:// dan http://
     * - Mengubah markdown link [url](url) menjadi teks biasa
     * - Menghilangkan karakter markdown seperti * dan `
     */
    private sanitizeReply(text: string): string {
        if (!text) return '';
        let cleaned = text;
        // 1. Ubah markdown link [https://example.com](https://example.com) atau [teks](url) menjadi plain url/teks
        cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
        // 2. Hilangkan prefix https:// atau http://
        cleaned = cleaned.replace(/https?:\/\//gi, '');
        // 3. Bersihkan formatting markdown seperti bold ** atau backticks `
        cleaned = cleaned.replace(/[*`]/g, '');
        // 4. Bersihkan spasi ganda
        cleaned = cleaned.replace(/[ \t]+/g, ' ').trim();
        return cleaned;
    }

    /**
     * Call backend API to generate / lookup Netflix token for buyer
     * Public agar DuokeModule bisa memanggil langsung untuk pre-fetch
     */
    async callBackendNetflixToken(buyerName?: string, orderId?: string): Promise<any> {
        const url = `${this.apiBaseUrl}/account/duoke/netflix-token`;
        const headers = authHeaders(this.authCredentials);

        try {
            this.logger.info(`[GeminiTool] Memanggil API generate-token untuk buyer: ${buyerName}, orderId: ${orderId}`);
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ buyerName, orderId }),
            });

            if (!res.ok) {
                const errText = await res.text();
                this.logger.error(`[GeminiTool] API error (${res.status}): ${errText}`);
                return { success: false, message: `Gagal query backend: status ${res.status}` };
            }

            const data = await res.json();
            // Sanitize link URLs: hilangkan https:// dan http:// agar Shopee tidak memblokir link
            if (data && typeof data === 'object') {
                const dataObj = data as Record<string, any>;
                for (const key of Object.keys(dataObj)) {
                    if (typeof dataObj[key] === 'string') {
                        dataObj[key] = dataObj[key].replace(/^https?:\/\//i, '');
                    }
                }
            }
            return data;
        } catch (error: any) {
            this.logger.error(`[GeminiTool] Network error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Retry helper: coba ulang hingga maxRetries kali jika error 503/429
     */
    private async callWithRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
        const totalAttempts = Math.max(maxRetries, this.apiKeys.length * 2);
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                const code = err?.error?.code ?? err?.status ?? 0;
                const errMsg = String(err?.message || '');
                const isDailyQuotaExhausted = errMsg.includes('RESOURCE_EXHAUSTED')
                    || errMsg.includes('limit: 20')
                    || errMsg.includes('limit exceeded')
                    || errMsg.includes('rate-limits');

                if (isDailyQuotaExhausted || code === 429) {
                    // Coba beralih ke API Key cadangan jika tersedia
                    if (this.rotateApiKey('Kuota/Rate Limit 429 Habis')) {
                        // Langsung coba lagi dengan API Key berikutnya tanpa delay!
                        continue;
                    }
                    this.logger.warn(`[GeminiChatService] Semua API Key kuota habis (429 RESOURCE_EXHAUSTED). Melewati retry.`);
                    throw err;
                }

                const isRetryable = code === 503 || code === 429
                    || errMsg.includes('503')
                    || errMsg.includes('UNAVAILABLE');
                if (isRetryable && attempt < totalAttempts) {
                    const delaySec = attempt * 2;
                    this.logger.warn(`[GeminiRetry] Error ${code} (${attempt}/${totalAttempts}) — retry dalam ${delaySec}s...`);
                    await new Promise(r => setTimeout(r, delaySec * 1000));
                } else {
                    throw err;
                }
            }
        }
        throw new Error('Max retries exceeded');
    }

    /**
     * Timeout wrapper untuk mencegah request ke Gemini menggantung tanpa batas waktu
     */
    private async withTimeout<T>(promise: Promise<T>, ms = 20000): Promise<T> {
        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Gemini API Timeout setelah ${ms / 1000} detik`)), ms);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    }

    /**
     * Process customer chat with Gemini Agent
     */
    async generateReply(params: {
        username: string;
        orderId?: string;
        orderStatus?: string;
        chatHistory: ChatMessage[];
        accountInfo?: any;
    }): Promise<GenerateReplyResult> {
        const { username, orderId, orderStatus, chatHistory, accountInfo } = params;

        this.logger.info(`[GeminiChatService] generateReply dipanggil untuk ${username}, chatHistory.length=${chatHistory?.length ?? 0}, orderStatus=${orderStatus}, hasAccountInfo=${!!accountInfo}`);

        // Format conversation history for Gemini (atau beri tahu jika kosong)
        let historyText: string;
        if (!chatHistory || chatHistory.length === 0) {
            this.logger.warn(`[GeminiChatService] chatHistory KOSONG untuk ${username} — Gemini tetap dipanggil dengan status order`);
            historyText = '(Riwayat obrolan tidak berhasil dibaca dari layar. Asumsikan pembeli baru membuka chat dan belum mengetik pesan)';
        } else {
            historyText = chatHistory
                .map(m => `[${m.sender === 'buyer' ? 'PEMBELI' : 'TOKO'}]: ${m.text}`)
                .join('\n');
        }

        // Sisipkan data identifikasi transaksi jika tersedia (pre-fetched oleh DuokeModule dari database)
        let accountSection = '';
        if (accountInfo) {
            accountSection = `\n\nDATA IDENTIFIKASI DATABASE TRANSAKSI (digitalpremium.id/dashboard/transaction):
- Terdaftar di Database: ${accountInfo.found ? 'Ya (Ditemukan)' : 'Tidak Ditemukan'}
- Varian Produk Terakhir: ${accountInfo.productName || 'Tidak diketahui'}
- Kode Voucher / Order ID: ${accountInfo.orderId || orderId || '-'}
- Tanggal Pembelian: ${accountInfo.orderDate ? new Date(accountInfo.orderDate).toLocaleString('id-ID') : '-'}
- Tanggal Masa Aktif Berakhir: ${accountInfo.expiredAt ? new Date(accountInfo.expiredAt).toLocaleString('id-ID') : '-'}
- Status Durasi Akun: ${accountInfo.hasActiveDuration ? 'MASIH AKTIF (DURASI MASIH ADA)' : (accountInfo.isExpired ? 'SUDAH HABIS (EXPIRED)' : 'Tidak diketahui')}
${accountInfo.pcLink ? `- Link PC/Laptop: ${accountInfo.pcLink}` : ''}
${accountInfo.mobileLink ? `- Link HP/Mobile: ${accountInfo.mobileLink}` : ''}
${accountInfo.tvLink ? `- Link TV: ${accountInfo.tvLink}` : ''}`;
        }

        const userPrompt = `Informasi Pelanggan:
- Username Shopee: ${username}
- Nomor Pesanan / Order ID / Kode: ${orderId || 'Tidak ada di panel'}
- Status Pesanan di Panel Shopee: ${orderStatus || 'Tidak terdeteksi'}${accountSection}

Riwayat Obrolan Terakhir:
${historyText}

Pesan terbaru berasal dari PEMBELI. Tolong buatkan balasan yang ramah dan solutif sesuai SOP toko (maksimal 2 kalimat). Gunakan data identifikasi database transaksi di atas.
PANDUAN UTAMA:
- Jika durasi MASIH AKTIF dan pembeli mengeluh kendala: jangan langsung vonis habis dan jangan langsung beri link, tanyakan dulu kendalanya dan tanyakan apakah login pakai TV, HP, atau Laptop. Jika pembeli sudah sebut perangkatnya (misal laptop/hp/tv), baru berikan link sesuai perangkat.
- Jika durasi SUDAH HABIS: sampaikan dengan sopan masa aktif paket terakhirnya sudah habis dan tawarkan perpanjang ke web/kewa.
- Jika TIDAK DITEMUKAN di database: tanyakan nomor pesanan atau kode voucher (VC-xxx).`;

        const tools = [
            {
                functionDeclarations: [
                    {
                        name: 'generate_netflix_link',
                        description: 'Mengambil link login 1-klik Netflix (PC, Mobile, TV) dari database untuk pembeli yang mengalami kendala login / butuh link baru',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                username: {
                                    type: 'STRING',
                                    description: 'Username pembeli di marketplace',
                                },
                                orderId: {
                                    type: 'STRING',
                                    description: 'Nomor pesanan pembeli jika ada',
                                },
                                device: {
                                    type: 'STRING',
                                    description: 'Perangkat yang digunakan pembeli (misal: tv, pc, hp, atau all)',
                                },
                            },
                            required: ['username'],
                        },
                    },
                    {
                        name: 'escalate_to_human',
                        description: 'Menyerahkan obrolan ke admin manusia jika pembeli komplain keras, meminta refund, atau terdapat masalah yang tidak dapat diselesaikan otomatis',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                reason: {
                                    type: 'STRING',
                                    description: 'Alasan eskalasi ke admin manusia',
                                },
                            },
                            required: ['reason'],
                        },
                    },
                ],
            },
        ];

        try {
            let firstResponse: any;
            try {
                this.logger.info(`Mengirim permintaan ke Gemini (${this.model}) untuk buyer: ${username}`);
                firstResponse = await this.callWithRetry(() => this.withTimeout(this.ai.models.generateContent({
                    model: this.model,
                    contents: userPrompt,
                    config: {
                        systemInstruction: this.buildSystemInstruction(),
                        tools: tools as any,
                        thinkingConfig: {
                            thinkingBudget: 0,
                        },
                    },
                }), 20000));
            } catch (err: any) {
                const fallbackModel = 'gemini-3.8-flash';
                if (this.model !== fallbackModel) {
                    this.logger.warn(`Gemini (${this.model}) gagal (${err.message}), mencoba fallback ke model ${fallbackModel}...`);
                    firstResponse = await this.callWithRetry(() => this.withTimeout(this.ai.models.generateContent({
                        model: fallbackModel,
                        contents: userPrompt,
                        config: {
                            systemInstruction: this.buildSystemInstruction(),
                            tools: tools as any,
                            thinkingConfig: {
                                thinkingBudget: 0,
                            },
                        },
                    }), 20000), 2);
                } else {
                    throw err;
                }
            }

            const candidate = firstResponse.candidates?.[0];
            const functionCalls = firstResponse.functionCalls;

            // If Gemini wants to call a tool
            if (functionCalls && functionCalls.length > 0) {
                const call = functionCalls[0];
                this.logger.info(`Gemini memanggil tool: ${call.name} dengan args: ${JSON.stringify(call.args)}`);

                if (call.name === 'escalate_to_human') {
                    const reason = (call.args as any)?.reason || 'Permintaan pembeli memerlukan admin manusia';
                    this.logger.warn(`[EscalateToHuman] Percakapan ${username} dieskalasikan: ${reason}`);
                    return {
                        replyText: this.sanitizeReply('Mohon ditunggu sebentar ya kak, kendala kakak sedang kami teruskan ke admin senior untuk dibantu pengecekan langsung ya kak 🙏'),
                        escalated: true,
                        toolUsed: 'escalate_to_human',
                    };
                }

                if (call.name === 'generate_netflix_link') {
                    const args = call.args as any;
                    const lookupUser = args.username || username;
                    const lookupOrderId = args.orderId || orderId;

                    const toolResult = await this.callBackendNetflixToken(lookupUser, lookupOrderId);
                    this.logger.info(`[GeminiTool] Hasil API untuk ${lookupUser}: success=${toolResult?.success}, isExpired=${toolResult?.isExpired}, hasLink=${!!toolResult?.pcLink || !!toolResult?.mobileLink}`);

                    // Kirim tool result ke Gemini untuk diinterpretasikan
                    const modelParts = candidate?.content?.parts || [];

                    const secondResponse = await this.callWithRetry(() => this.withTimeout(this.ai.models.generateContent({
                        model: this.model,
                        contents: [
                            { role: 'user', parts: [{ text: userPrompt }] },
                            { role: 'model', parts: modelParts as any },
                            {
                                role: 'user',
                                parts: [
                                    {
                                        functionResponse: {
                                            name: 'generate_netflix_link',
                                            response: toolResult,
                                        },
                                    } as any,
                                ],
                            },
                        ],
                        config: {
                            systemInstruction: this.buildSystemInstruction(),
                            tools: tools as any,
                            thinkingConfig: {
                                thinkingBudget: 0,
                            },
                        },
                    }), 20000));


                    const finalText = secondResponse.text?.trim() || '';
                    // Jika Gemini tidak menghasilkan teks, fallback berdasarkan tool result
                    let fallbackText = 'Mohon infokan nomor pesanan atau kode voucher (VC-xxx) kakak ya, agar kami bisa bantu cek datanya 🙏';
                    if (toolResult?.hasActiveDuration === true || (toolResult?.success === true && toolResult?.isExpired === false)) {
                        fallbackText = 'Gabisanya gimana kak? Loginnya di perangkat apa ya (TV, HP, atau Laptop)?';
                    } else if (toolResult?.isExpired === true) {
                        fallbackText = `Mohon maaf kak, masa aktif pesanan kakak untuk ${toolResult?.productName || 'paket sebelumnya'} sudah berakhir. Bisa order keweb kita dulu paytronik.digitalpremium.id/product atau kewa s.id/LangganandiWea ya kak 🙏`;
                    }

                    // Anti-halusinasi link: Kumpulkan semua link resmi yang berasal dari database
                    const officialLinks = [
                        toolResult?.pcLink,
                        toolResult?.mobileLink,
                        toolResult?.tvLink,
                        toolResult?.generalLink,
                        accountInfo?.pcLink,
                        accountInfo?.mobileLink,
                        accountInfo?.tvLink,
                        accountInfo?.generalLink,
                    ].filter(Boolean) as string[];

                    let chosenText = finalText || fallbackText;
                    // Cek apakah balasan AI mengandung link shorturl "/l/..."
                    const linkMatches = chosenText.match(/(?:[a-zA-Z0-9-]+\.)?digitalpremium\.id\/l\/[a-zA-Z0-9_-]+/gi) || [];
                    for (const matchedLink of linkMatches) {
                        const isLegit = officialLinks.some(off => off.toLowerCase().includes(matchedLink.toLowerCase()));
                        if (!isLegit) {
                            this.logger.warn(`[GeminiChatService] Terdeteksi link palsu/halusinasi AI: "${matchedLink}". Mengganti dengan respon resmi.`);
                            chosenText = fallbackText;
                            break;
                        }
                    }

                    const reply = this.sanitizeReply(chosenText);
                    this.logger.info(`[GeminiChatService] Balasan (Tool) berhasil disusun untuk ${username}: "${reply}"`);
                    return {
                        replyText: reply,
                        escalated: false,
                        toolUsed: 'generate_netflix_link',
                    };
                }
            }

            // Normal text response
            const replyText = firstResponse.text?.trim() || 'Ready kak, silakan diorder ya 😊';
            let chosenNormal = replyText;
            const normalLinks = chosenNormal.match(/(?:[a-zA-Z0-9-]+\.)?digitalpremium\.id\/l\/[a-zA-Z0-9_-]+/gi) || [];
            if (normalLinks.length > 0) {
                const officialLinks = [
                    accountInfo?.pcLink,
                    accountInfo?.mobileLink,
                    accountInfo?.tvLink,
                    accountInfo?.generalLink,
                ].filter(Boolean) as string[];
                for (const matched of normalLinks) {
                    if (!officialLinks.some(off => off.toLowerCase().includes(matched.toLowerCase()))) {
                        this.logger.warn(`[GeminiChatService] Terdeteksi link palsu di balasan teks biasa: "${matched}". Dihapus.`);
                        chosenNormal = chosenNormal.replace(matched, '').trim();
                    }
                }
            }
            const sanitized = this.sanitizeReply(chosenNormal);
            this.logger.info(`[GeminiChatService] Balasan berhasil disusun untuk ${username}: "${sanitized}"`);
            return {
                replyText: sanitized,
                escalated: false,
            };
        } catch (error: any) {
            this.logger.error(`Error saat generate reply dari Gemini: ${error.message}`);
            // Fallback cerdas berdasarkan data database yang sudah berhasil diidentifikasi
            let intelligentFallback = 'Halo kak! Pesanan kakak sudah kami terima. Jika ada kendala teknis atau pertanyaan, mohon infokan detailnya ya kak 🙏';
            if (accountInfo) {
                if (accountInfo.isExpired === true) {
                    intelligentFallback = `Mohon maaf kak, setelah kami cek masa aktif akun untuk paket ${accountInfo.productName || 'Netflix'} sudah berakhir. Kakak bisa order keweb kita dulu paytronik.digitalpremium.id/product atau kewa s.id/LangganandiWea ya kak 😊`;
                } else if (accountInfo.hasActiveDuration === true) {
                    intelligentFallback = 'Gabisanya gimana kak? Loginnya di perangkat apa ya (TV, HP, atau Laptop)?';
                } else if (accountInfo.found === false) {
                    intelligentFallback = 'Halo kak, boleh infokan nomor pesanan Shopee atau kode voucher (format VC-xxx) kakak? Biar kami bantu cek datanya ya kak 🙏';
                }
            }
            return {
                replyText: this.sanitizeReply(intelligentFallback),
                escalated: false,
            };
        }
    }
}
