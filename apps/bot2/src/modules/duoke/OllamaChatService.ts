/**
 * OllamaChatService - Local AI Agent service powered by Ollama (Qwen 2.5) for Duoke Auto-Reply
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProjectRoot } from '../../utils/path.js';
import type { Logger } from '../../core/Logger.js';
import type { AuthCredentials } from '../../core/auth.js';
import { authHeaders } from '../../core/auth.js';
import type { ChatMessage } from './locators.js';
import type { GenerateReplyResult } from './GeminiChatService.js';

export interface OllamaServiceOptions {
    baseUrl?: string;
    model?: string;
    sopFilePath?: string;
    apiBaseUrl: string;
    authCredentials: AuthCredentials;
    logger: Logger;
}

export class OllamaChatService {
    private baseUrl: string;
    private model: string;
    private sopContent: string = '';
    private apiBaseUrl: string;
    private authCredentials: AuthCredentials;
    private logger: Logger;

    constructor(options: OllamaServiceOptions) {
        this.baseUrl = (options.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.model = options.model || 'qwen2.5:7b';
        this.apiBaseUrl = options.apiBaseUrl.startsWith('http') ? options.apiBaseUrl : `http://${options.apiBaseUrl}`;
        this.authCredentials = options.authCredentials;
        this.logger = options.logger;

        this.loadSop(options.sopFilePath);
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
                    this.logger.info(`OllamaChatService: SOP loaded from ${p}`);
                    return;
                } catch (e) {
                    this.logger.warn(`OllamaChatService: Gagal membaca SOP di ${p}: ${e}`);
                }
            }
        }

        this.logger.warn('OllamaChatService: File SOP tidak ditemukan, menggunakan SOP default.');
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
7. DILARANG mengarang link, email, atau password.

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
       - HP/Mobile: berikan link mobileLink atau generalLink (tulis polos tanpa https://).
       - TV: berikan link tvLink dan infokan untuk dibuka di browser HP/PC yang satu Wi-Fi dengan TV lalu masukkan kode TV.

B. JIKA DATA DATABASE: MASA AKTIF SUDAH HABIS (isExpired=true):
   - Sampaikan dengan sopan dan jelaskan berdasarkan varian transaksi terakhirnya:
     Contoh: "Mohon maaf kak, setelah kami cek transaksi terakhir kakak untuk [Varian Produk], masa aktifnya sudah berakhir. Kakak bisa order keweb kita dulu paytronik.digitalpremium.id/product atau kewa s.id/LangganandiWea ya kak 😊"

C. JIKA DATA DATABASE: TIDAK DITEMUKAN (found=false):
   - DILARANG mengklaim masa aktif habis!
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
     * Sanitasi balasan AI agar mematuhi aturan Shopee
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
            this.logger.info(`[OllamaTool] Memanggil API generate-token untuk buyer: ${buyerName}, orderId: ${orderId}`);
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ buyerName, orderId }),
            });

            if (!res.ok) {
                const errText = await res.text();
                this.logger.error(`[OllamaTool] API error (${res.status}): ${errText}`);
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
            this.logger.error(`[OllamaTool] Network error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Timeout wrapper untuk mencegah request menggantung
     */
    private async withTimeout<T>(promise: Promise<T>, ms = 25000): Promise<T> {
        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Ollama API Timeout setelah ${ms / 1000} detik`)), ms);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    }

    /**
     * Call Ollama /api/chat endpoint
     */
    private async postOllamaChat(body: Record<string, any>): Promise<any> {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
        }

        return await res.json();
    }

    /**
     * Process customer chat with Ollama Agent
     */
    async generateReply(params: {
        username: string;
        orderId?: string;
        orderStatus?: string;
        chatHistory: ChatMessage[];
        accountInfo?: any;
    }): Promise<GenerateReplyResult> {
        const { username, orderId, orderStatus, chatHistory, accountInfo } = params;

        this.logger.info(`[OllamaChatService] generateReply dipanggil untuk ${username}, model=${this.model}, hasAccountInfo=${!!accountInfo}`);

        let historyText: string;
        if (!chatHistory || chatHistory.length === 0) {
            historyText = '(Riwayat obrolan tidak berhasil dibaca dari layar. Asumsikan pembeli baru membuka chat)';
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
                type: 'function',
                function: {
                    name: 'generate_netflix_link',
                    description: 'Mengambil link login 1-klik Netflix (PC, Mobile, TV) dari database untuk pembeli yang mengalami kendala login / butuh link baru',
                    parameters: {
                        type: 'object',
                        properties: {
                            username: {
                                type: 'string',
                                description: 'Username pembeli di marketplace',
                            },
                            orderId: {
                                type: 'string',
                                description: 'Nomor pesanan pembeli jika ada',
                            },
                            device: {
                                type: 'string',
                                description: 'Perangkat yang digunakan pembeli (misal: tv, pc, hp, atau all)',
                            },
                        },
                        required: ['username'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'escalate_to_human',
                    description: 'Menyerahkan obrolan ke admin manusia jika pembeli komplain keras, meminta refund, atau terdapat masalah yang tidak dapat diselesaikan otomatis',
                    parameters: {
                        type: 'object',
                        properties: {
                            reason: {
                                type: 'string',
                                description: 'Alasan eskalasi ke admin manusia',
                            },
                        },
                        required: ['reason'],
                    },
                },
            },
        ];

        const messages: any[] = [
            { role: 'system', content: this.buildSystemInstruction() },
            { role: 'user', content: userPrompt },
        ];

        try {
            this.logger.info(`Mengirim permintaan ke Ollama (${this.model}) untuk buyer: ${username}`);
            const firstResponse = await this.withTimeout(this.postOllamaChat({
                model: this.model,
                messages,
                tools,
                stream: false,
                options: {
                    temperature: 0.3,
                },
            }), 25000);

            const assistantMessage = firstResponse.message;
            const toolCalls = assistantMessage?.tool_calls;

            if (toolCalls && toolCalls.length > 0) {
                const call = toolCalls[0];
                const fnName = call.function?.name;
                let fnArgs = call.function?.arguments || {};
                if (typeof fnArgs === 'string') {
                    try {
                        fnArgs = JSON.parse(fnArgs);
                    } catch {
                        fnArgs = {};
                    }
                }

                this.logger.info(`Ollama memanggil tool: ${fnName} dengan args: ${JSON.stringify(fnArgs)}`);

                if (fnName === 'escalate_to_human') {
                    const reason = fnArgs.reason || 'Permintaan pembeli memerlukan admin manusia';
                    this.logger.warn(`[EscalateToHuman] Percakapan ${username} dieskalasikan: ${reason}`);
                    return {
                        replyText: this.sanitizeReply('Mohon ditunggu sebentar ya kak, kendala kakak sedang kami teruskan ke admin senior untuk dibantu pengecekan langsung ya kak 🙏'),
                        escalated: true,
                        toolUsed: 'escalate_to_human',
                    };
                }

                if (fnName === 'generate_netflix_link') {
                    const lookupUser = fnArgs.username || username;
                    const lookupOrderId = fnArgs.orderId || orderId;

                    const toolResult = await this.callBackendNetflixToken(lookupUser, lookupOrderId);
                    this.logger.info(`[OllamaTool] Hasil API untuk ${lookupUser}: success=${toolResult?.success}, isExpired=${toolResult?.isExpired}`);

                    // Kirim hasil tool kembali ke Ollama
                    messages.push(assistantMessage);
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(toolResult),
                    });

                    const secondResponse = await this.withTimeout(this.postOllamaChat({
                        model: this.model,
                        messages,
                        tools,
                        stream: false,
                        options: {
                            temperature: 0.3,
                        },
                    }), 25000);

                    const finalText = secondResponse.message?.content?.trim() || '';
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
                    const linkMatches = chosenText.match(/(?:[a-zA-Z0-9-]+\.)?digitalpremium\.id\/l\/[a-zA-Z0-9_-]+/gi) || [];
                    for (const matchedLink of linkMatches) {
                        const isLegit = officialLinks.some(off => off.toLowerCase().includes(matchedLink.toLowerCase()));
                        if (!isLegit) {
                            this.logger.warn(`[OllamaChatService] Terdeteksi link palsu/halusinasi AI: "${matchedLink}". Mengganti dengan respon resmi.`);
                            chosenText = fallbackText;
                            break;
                        }
                    }

                    const reply = this.sanitizeReply(chosenText);
                    this.logger.info(`[OllamaChatService] Balasan (Tool) berhasil disusun untuk ${username}: "${reply}"`);
                    return {
                        replyText: reply,
                        escalated: false,
                        toolUsed: 'generate_netflix_link',
                    };
                }
            }

            // Balasan teks biasa
            const replyText = assistantMessage?.content?.trim() || 'Ready kak, silakan diorder ya 😊';
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
                        this.logger.warn(`[OllamaChatService] Terdeteksi link palsu di balasan teks biasa: "${matched}". Dihapus.`);
                        chosenNormal = chosenNormal.replace(matched, '').trim();
                    }
                }
            }
            const sanitized = this.sanitizeReply(chosenNormal);
            this.logger.info(`[OllamaChatService] Balasan berhasil disusun untuk ${username}: "${sanitized}"`);
            return {
                replyText: sanitized,
                escalated: false,
            };
        } catch (error: any) {
            this.logger.error(`Error saat generate reply dari Ollama: ${error.message}`);
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
