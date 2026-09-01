import { INetflixModuleContext } from "../interfaces/netflix-module.interface.js";
import type { Task } from "../../../types/task.type.js";
import { CHANGE_PLAN_URL, PLAN_PREMIUM_ID } from "../constants.js";
import { sanitizeEmail } from "../utils.js";
import { updateNetflixPlan } from "../api.js";
import { UPGRADE_LOCATORS } from "../locators/upgrade.js";
import { NetflixAuthService } from "./NetflixAuthService.js";

export class NetflixUpgradeService {
  private authService: NetflixAuthService;

  constructor(private readonly ctx: INetflixModuleContext) {
    this.authService = new NetflixAuthService(ctx);
  }

  async execute(task: Task): Promise<void> {
    const payload = task.payload as any;
    const email = payload.email;
    const password = payload.password;
    const accountId = payload.accountId;

    const contextName = sanitizeEmail(email);
    this.ctx.logger.info(`[AutoUpgrade][${email}] Memulai proses upgrade ke Premium...`);

    const context = await this.ctx.getOrCreateContext(contextName);
    const page = await context.newPage();

    try {
      // STEP 1: Cek Login
      await page.goto(CHANGE_PLAN_URL);
      let loginState = await this.authService.detectLoginState(page);

      if (loginState === "not_logged_in") {
        this.ctx.logger.info(`[AutoUpgrade][${email}] Belum login, mencoba login manual...`);
        const loginSuccess = await this.authService.attemptManualLogin(page, email, password);
        
        if (!loginSuccess) {
          this.ctx.logger.warn(`[AutoUpgrade][${email}] Login manual gagal, mencoba fallback via Reset Link...`);
          const fallbackSuccess = await this.authService.handleFallbackLoginViaReset(page, task, email);
          if (!fallbackSuccess) {
            throw new Error("Gagal login manual maupun via Reset Link untuk proses upgrade.");
          }
        }
        
        await page.goto(CHANGE_PLAN_URL);
      }

      // STEP 2: Tunggu halaman changeplan siap, lalu cek status plan
      this.ctx.logger.info(`[AutoUpgrade][${email}] Menunggu halaman changeplan siap...`);
      
      const premiumChoice = page.locator(UPGRADE_LOCATORS.planChoice(PLAN_PREMIUM_ID));
      
      try {
        await premiumChoice.waitFor({ state: 'visible', timeout: 15000 });
      } catch (err) {
        // Jika label tidak muncul, URL mungkin berubah (redirect ke membership)
        this.ctx.logger.warn(`[AutoUpgrade][${email}] Label plan tidak ditemukan (URL: ${page.url()}). Mungkin sudah Premium atau belum bisa upgrade.`);
        throw new Error(`Label plan Premium tidak ditemukan pada URL: ${page.url()}`);
      }

      // Cek apakah Premium sudah aktif (selected-indicator ada di label Premium)
      const alreadyPremium = await page.locator(UPGRADE_LOCATORS.selectedIndicator(PLAN_PREMIUM_ID)).isVisible();
      if (alreadyPremium) {
        this.ctx.logger.warn(`[AutoUpgrade][${email}] Akun sudah menggunakan paket Premium. Proses selesai.`);
        try {
          await updateNetflixPlan(this.ctx.apiBaseUrl, this.ctx.authCredentials, accountId, 'Premium');
        } catch (_) {}
        return;
      }

      this.ctx.logger.info(`[AutoUpgrade][${email}] Mengklik pilihan plan Premium (ID: ${PLAN_PREMIUM_ID})...`);
      await premiumChoice.click();
      await this.ctx.sleep(1500);

      // STEP 3: Klik Lanjutkan
      this.ctx.logger.info(`[AutoUpgrade][${email}] Mencari tombol Lanjutkan...`);
      const continueBtn = page.locator(UPGRADE_LOCATORS.continueButton);

      // Fallback: cari berdasarkan teks jika data-uia tidak cocok
      let continueBtnFound = false;
      try {
        await continueBtn.first().waitFor({ state: 'visible', timeout: 8000 });
        continueBtnFound = true;
      } catch (_) {}

      if (!continueBtnFound) {
        this.ctx.logger.warn(`[AutoUpgrade][${email}] Tombol lanjutkan via data-uia tidak ditemukan, mencoba via teks...`);
        const textFallback = page.locator('button').filter({ hasText: /lanjut|lanjutkan|continue|next/i });
        try {
          await textFallback.first().waitFor({ state: 'visible', timeout: 5000 });
          await textFallback.first().click();
        } catch (_) {
          throw new Error('Tombol Lanjutkan tidak ditemukan (data-uia maupun teks).');
        }
      } else {
        await continueBtn.first().click();
      }
      await this.ctx.sleep(2000);

      // STEP 3.5: Cek apakah ada tantangan OTP sebelum konfirmasi
      this.ctx.logger.info(`[AutoUpgrade][${email}] Mengecek apakah diperlukan verifikasi OTP...`);
      
      const mfaEmailBtn = page.locator('div[data-uia="account-mfa-button-OTP_EMAIL"]');
      const isOtpRequired = await mfaEmailBtn.isVisible({ timeout: 5000 }).catch(() => false);

      if (isOtpRequired) {
        this.ctx.logger.info(`[AutoUpgrade][${email}] Tantangan OTP terdeteksi. Melakukan klik opsi Email...`);
        await mfaEmailBtn.click();
        await this.ctx.sleep(1500);

        // Klik tombol Kirim
        this.ctx.logger.info(`[AutoUpgrade][${email}] Mengklik tombol Kirim OTP...`);
        const sendBtn = page.locator('button[data-uia="collect-input-submit-cta"]');
        await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
        await sendBtn.click();
        
        // Menunggu kode OTP via socket event
        const otpEventName = `${sanitizeEmail(email)}:NETFLIX_OTP`;
        this.ctx.eventBus.emit('socket:subscribe', otpEventName);
        this.ctx.logger.info(`[AutoUpgrade][${email}] Menunggu OTP dari email (Filter: Verification Code)...`);
        
        let otpCode = '';
        try {
            // Kita tunggu sampai mendapatkan subject yang benar (Whitelist)
            while (!otpCode) {
                const eventData = await this.ctx.waitForTaskEvent<any>(task.id, otpEventName);
                const subject = (eventData.subject || "").toLowerCase();
                
                this.ctx.logger.info(`[AutoUpgrade][${email}] Menerima email untuk OTP dengan subject: "${eventData.subject}"`);

                if (subject.includes("your verification code") || subject.includes("kode verifikasimu")) {
                    otpCode = eventData.data;
                    this.ctx.logger.info(`[AutoUpgrade][${email}] OTP VALID ditemukan: ${otpCode}. Memasukkan kode...`);
                } else if (subject.includes("kode masukmu") || subject.includes("login code")) {
                    this.ctx.logger.warn(`[AutoUpgrade][${email}] Subject "${eventData.subject}" diabaikan (Email Login Link). Menunggu email OTP Verifikasi yang benar...`);
                    // Loop berlanjut, waitForTaskEvent akan menunggu event socket berikutnya
                } else {
                    this.ctx.logger.warn(`[AutoUpgrade][${email}] Subject "${eventData.subject}" tidak sesuai kriteria. Menunggu email OTP...`);
                }
            }

            // Memasukkan kode OTP ke dalam input
            const otpInput = page.locator('input[data-uia="collect-otp-input-entry"]');
            await otpInput.waitFor({ state: 'visible', timeout: 15000 });
            await otpInput.fill(otpCode);
            await this.ctx.sleep(1000);

            // Mengklik tombol submit OTP (Kirim)
            this.ctx.logger.info(`[AutoUpgrade][${email}] Mengklik tombol Kirim / Submit OTP...`);
            const submitOtpBtn = page.locator('button[data-uia="collect-input-submit-cta"]');
            await submitOtpBtn.waitFor({ state: 'visible', timeout: 5000 });
            await submitOtpBtn.click();
            await this.ctx.sleep(3000);
        } catch (error: any) {
            this.ctx.logger.error(`[AutoUpgrade][${email}] Gagal saat memproses OTP: ${error.message}`);
            throw error;
        }
      }

      // STEP 4: Konfirmasi Upgrade (Halaman Final)
      // Tombol dari DOM: <button data-uia="action-button">Confirm</button>
      this.ctx.logger.info(`[AutoUpgrade][${email}] Menunggu halaman konfirmasi akhir...`);
      const confirmBtn = page.locator(UPGRADE_LOCATORS.confirmUpgradeButton);

      let confirmClicked = false;
      try {
        await confirmBtn.first().waitFor({ state: 'visible', timeout: 15000 });
        this.ctx.logger.info(`[AutoUpgrade][${email}] Klik Konfirmasi Perubahan Paket (via data-uia)...`);
        await confirmBtn.first().click();
        confirmClicked = true;
        await this.ctx.sleep(3000);
      } catch (_) {}

      // Fallback: cari tombol Confirm via teks
      if (!confirmClicked) {
        this.ctx.logger.warn(`[AutoUpgrade][${email}] Tombol via data-uia tidak ditemukan, mencoba via teks "Confirm"...`);
        const textConfirm = page.locator('button').filter({ hasText: /^confirm$/i });
        try {
          await textConfirm.first().waitFor({ state: 'visible', timeout: 5000 });
          this.ctx.logger.info(`[AutoUpgrade][${email}] Klik Konfirmasi via teks...`);
          await textConfirm.first().click();
          confirmClicked = true;
          await this.ctx.sleep(3000);
        } catch (_) {
          this.ctx.logger.warn(`[AutoUpgrade][${email}] Tombol konfirmasi tidak ditemukan sama sekali, langsung cek status...`);
        }
      }

      // STEP 5: Tunggu & Verifikasi Sukses
      // Teks sukses dari DOM: "You've successfully changed your plan"
      this.ctx.logger.info(`[AutoUpgrade][${email}] Menunggu konfirmasi sukses dari Netflix...`);

      let isSuccess = false;

      // Prioritas 1: Tunggu teks sukses spesifik (paling akurat)
      try {
        await page.locator('text="You\'ve successfully changed your plan"').waitFor({ state: 'visible', timeout: 15000 });
        isSuccess = true;
        this.ctx.logger.info(`[AutoUpgrade][${email}] ✅ Terdeteksi teks sukses: "You've successfully changed your plan"`);
      } catch (_) {
        this.ctx.logger.warn(`[AutoUpgrade][${email}] Teks sukses tidak muncul dalam 15s, cek alternatif...`);
      }

      // Prioritas 2: Cek via data-uia success-message
      if (!isSuccess) {
        isSuccess = await page.locator(UPGRADE_LOCATORS.successMessage).isVisible({ timeout: 3000 }).catch(() => false);
        if (isSuccess) this.ctx.logger.info(`[AutoUpgrade][${email}] ✅ Terdeteksi success-message element.`);
      }

      // Prioritas 3: Cek URL (sudah keluar dari halaman changeplan)
      const currentUrl = page.url();
      if (!isSuccess) {
        isSuccess = currentUrl.includes('membership') || currentUrl.includes('YourAccount');
        if (isSuccess) this.ctx.logger.info(`[AutoUpgrade][${email}] ✅ Terdeteksi redirect sukses ke: ${currentUrl}`);
      }

      if (isSuccess) {
        this.ctx.logger.info(`[AutoUpgrade][${email}] 🎉 UPGRADE PAKET PREMIUM BERHASIL! URL akhir: ${currentUrl}`);
        try {
          await updateNetflixPlan(this.ctx.apiBaseUrl, this.ctx.authCredentials, accountId, 'Premium');
          this.ctx.logger.info(`[AutoUpgrade][${email}] Database berhasil diperbarui ke Premium.`);
        } catch (dbErr) {
          this.ctx.logger.warn(`[AutoUpgrade][${email}] Gagal update plan di DB: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
        }
      } else {
        this.ctx.logger.warn(`[AutoUpgrade][${email}] ❌ Status sukses TIDAK terdeteksi. URL akhir: ${currentUrl}`);
        throw new Error(`Upgrade selesai namun sukses tidak terdeteksi. URL: ${currentUrl}`);
      }

    } catch (error) {
      this.ctx.logger.error(
        `[AutoUpgrade] Gagal upgrade akun ${email}: ${error instanceof Error ? error.message : String(error)}`,
        { instanceId: this.ctx.instanceId },
      );
      throw error;
    } finally {
      await this.cleanupTask(page, contextName);
    }
  }

  private async cleanupTask(page: any, contextName: string): Promise<void> {
    await page.close();
    await this.ctx.saveSession(contextName, true);
    const ctx = this.ctx.getContextByName(contextName);
    if (ctx) {
      await ctx.close();
      this.ctx.invalidateContext(contextName);
    }
  }
}
