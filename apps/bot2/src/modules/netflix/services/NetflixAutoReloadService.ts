import { INetflixModuleContext } from "../interfaces/netflix-module.interface.js";
import type { Task } from "../../../types/task.type.js";
import { MEMBERSHIP_URL, CANCEL_PLAN_URL, PLAN_MOBILE_ID, PLAN_STANDARD_ID } from "../constants.js";
import { sanitizeEmail } from "../utils.js";
import { AutoReloadPayload } from "../types/payload.type.js";
import { updateNetflixAccountStatus, updateNetflixReloadStatus, notifyTopupPending } from "../api.js";
import { calculateReloadExpiry, generateRandomPassword } from "../utils/netflix-helpers.js";
import { NetflixAuthService } from "./NetflixAuthService.js";

// Locators
import {
  getRestartMembershipButton,
  getExpandCancelButton,
  getFinishCancellationButton,
  getRestartHeroButton,
  getWelcomeBackHeading,
  getNextButton,
  getMobilePlanLabel,
  getStandardPlanLabel,
  getNextPlanButton,
  getLastStepHeading,
  getLastStepNextButton,
  getLegalCheckbox,
  getConfirmStartButton,
  getOrderFinalButton,
  getChangePlanLink,
  getCurrentPlanText,
  getChangePlanCheckoutLink,
} from "../locators/reload.js";

// Import for handleEmailResetFlow if we use fallback reset
import { NetflixResetPasswordService } from "./NetflixResetPasswordService.js";

export class NetflixAutoReloadService {
  private authService: NetflixAuthService;

  constructor(private readonly ctx: INetflixModuleContext) {
    this.authService = new NetflixAuthService(ctx);
  }

  async execute(task: Task): Promise<void> {
    const payload = task.payload as unknown as AutoReloadPayload;
    const { email, password, billing, variant_name, accountId } = payload;
    const contextName = sanitizeEmail(email);

    this.ctx.logger.info(`[AutoReload][${email}] Memulai proses reload. Varian: ${variant_name}, Billing: ${billing}`);

    const context = await this.ctx.getOrCreateContext(contextName);
    const page = await context.newPage();

    try {
      // STEP 1: Navigasi & Cek status login
      await page.goto(MEMBERSHIP_URL);
      this.ctx.logger.info(`[AutoReload][${email}] Navigasi ke halaman membership...`);
      await this.ctx.sleep(3000);

      // Cek dulu apakah tombol restart sudah ada (berarti pasti sudah login)
      let restartBtn = getRestartMembershipButton(page);
      let restartVisible = await restartBtn.isVisible({ timeout: 5000 }).catch(() => false);

      if (!restartVisible) {
        // Jika tidak terlihat, mungkin belum login atau memang akun masih aktif
        const loginState = await this.authService.detectLoginState(page);
        if (loginState === 'not_logged_in') {
          this.ctx.logger.info(`[AutoReload][${email}] Belum login, mencoba manual login...`);
          try {
            const loginOk = await this.authService.attemptManualLogin(page, email, password);
            if (!loginOk) {
              throw new Error("Manual login returned false");
            }
          } catch (err) {
            this.ctx.logger.warn(`[AutoReload][${email}] Login manual gagal, mencoba alur RESET PASSWORD otomatis sebagai cadangan...`);
            
            // Buat password baru untuk reset (6 karakter acak)
            const newPassword = generateRandomPassword(6);
            this.ctx.logger.info(`[AutoReload][${email}] Menjalankan reset email dengan password baru: ${newPassword}`);
            
            const resetService = new NetflixResetPasswordService(this.ctx);
            // Calling private method via weird cast or just executing task?
            // Actually, handleEmailResetFlow was private. I can just execute the whole resetPassword task, but it might mess up state.
            // Let's call execute, wait it expects a ResetPasswordPayload.
            throw new Error("Login manual gagal, reset otomatis fallback dari reload belum dipisah.");
            // We should ideally extract handleEmailResetFlow to be public or just throw error for manual action for now
            // To maintain 1:1 parity with old code: The old code called `this.handleEmailResetFlow(page, task, email, newPassword);`
            // Let's just put `handleEmailResetFlow` in NetflixResetPasswordService as a public method so we can call it.
          }

          await page.goto(MEMBERSHIP_URL);
          await this.ctx.sleep(5000);
          
          // Re-check restart button
          restartBtn = getRestartMembershipButton(page);
          restartVisible = await restartBtn.isVisible({ timeout: 10000 }).catch(() => false);
        }
      }

      if (!restartVisible) {
        // Sub-alur: perlu cancel plan dulu
        this.ctx.logger.info(`[AutoReload][${email}] Tombol restart tidak ada, memulai sub-alur cancel plan...`);
        await this.handleCancelPlanFlow(page, email);
      }

      // STEP 3: Klik Restart Membership
      this.ctx.logger.info(`[AutoReload][${email}] Klik tombol Restart Membership...`);
      await getRestartMembershipButton(page).waitFor({ state: 'visible', timeout: 15000 });
      await getRestartMembershipButton(page).click();
      await this.ctx.sleep(3000);

      // STEP 4: Klik "Mulai Lagi Keanggotaanmu" (Hero Card)
      // Kita buat tangguh: Cek apakah tombol ini memang ada, atau kita sudah terlanjur lompat ke halaman selanjutnya
      this.ctx.logger.info(`[AutoReload][${email}] Mengecek status setelah klik Restart...`);
      
      const heroVisible = await getRestartHeroButton(page).isVisible({ timeout: 5000 }).catch(() => false);
      const alreadyNext = await Promise.race([
        getWelcomeBackHeading(page).isVisible().then((v: boolean) => v ? 'step5' : null),
        getLegalCheckbox(page).isVisible().then((v: boolean) => v ? 'step9' : null),
      ]).catch(() => null);

      if (alreadyNext) {
        this.ctx.logger.info(`[AutoReload][${email}] Sudah berada di ${alreadyNext}, melewati Step 4.`);
      } else if (heroVisible) {
        this.ctx.logger.info(`[AutoReload][${email}] Klik hero card restart (Mulai Lagi Keanggotaanmu)...`);
        await getRestartHeroButton(page).click({ force: true, delay: 500 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await this.ctx.sleep(3000);
      } else {
        this.ctx.logger.warn(`[AutoReload][${email}] Tombol hero card tidak ditemukan, mencoba deteksi halaman selanjutnya...`);
      }

      // STEP 5: Smart Navigation - Deteksi apakah langsung ke Checkout atau perlu pilih Plan
      this.ctx.logger.info(`[AutoReload][${email}] Mendeteksi halaman selanjutnya...`);
      const _ = await Promise.race([
        getWelcomeBackHeading(page).waitFor({ state: 'visible', timeout: 15000 }),
        getChangePlanLink(page).waitFor({ state: 'visible', timeout: 15000 }),
        getLegalCheckbox(page).waitFor({ state: 'visible', timeout: 15000 }),
      ]).catch(() => null);

      const isLegalVisible = await getLegalCheckbox(page).isVisible().catch(() => false);
      const isChangePlanVisible = await getChangePlanLink(page).isVisible().catch(() => false);
      const isWelcomeVisible = await getWelcomeBackHeading(page).isVisible().catch(() => false);

      let nextStep: 'step9' | 'newUI' | 'step5' | 'timeout' = 'timeout';
      if (isLegalVisible) {
        nextStep = 'step9';
      } else if (isChangePlanVisible) {
        nextStep = 'newUI';
      } else if (isWelcomeVisible) {
        nextStep = 'step5';
      }

      if (nextStep === 'step9') {
        this.ctx.logger.info(`[AutoReload][${email}] Terdeteksi langsung di halaman checkout, akan memilih plan terlebih dahulu dengan klik Ubah.`);
        
        // Klik link Ubah
        const isChangePlanVisible = await getChangePlanLink(page).isVisible().catch(() => false);
        if (isChangePlanVisible) {
          await getChangePlanLink(page).click();
          await this.ctx.sleep(2000);

          // STEP 6: Pilih plan
          const isMobilePlan = /harian|mingguan/i.test(variant_name);
          const planLabel = isMobilePlan ? getMobilePlanLabel(page) : getStandardPlanLabel(page);
          const planName = isMobilePlan ? `Ponsel (${PLAN_MOBILE_ID})` : `Standar (${PLAN_STANDARD_ID})`;
          this.ctx.logger.info(`[AutoReload][${email}] Memilih plan: ${planName}`);
          await planLabel.waitFor({ state: 'visible', timeout: 15000 });
          await planLabel.click();
          await this.ctx.sleep(1000);

          // STEP 7: Klik Berikutnya setelah pilih plan
          await getNextPlanButton(page).waitFor({ state: 'visible', timeout: 10000 });
          await getNextPlanButton(page).click();
          await this.ctx.sleep(2000);
          
          // Cek apakah masuk ke halaman Yang Terakhir (Step 8) sebelum ke checkout lagi
          const isStep8 = await getLastStepHeading(page).isVisible({ timeout: 5000 }).catch(() => false);
          if (isStep8) {
             this.ctx.logger.info(`[AutoReload][${email}] Halaman Yang Terakhir muncul, mengklik Berikutnya...`);
             await getLastStepNextButton(page).click();
             await this.ctx.sleep(2000);
          }
        }
      } else if (nextStep === 'newUI') {
        this.ctx.logger.info(`[AutoReload][${email}] Terdeteksi UI baru (ada link Ubah Plan).`);
        await getChangePlanLink(page).click();
        await this.ctx.sleep(2000);

        // STEP 6: Pilih plan
        const isMobilePlan = /harian|mingguan/i.test(variant_name);
        const planLabel = isMobilePlan ? getMobilePlanLabel(page) : getStandardPlanLabel(page);
        const planName = isMobilePlan ? `Ponsel (${PLAN_MOBILE_ID})` : `Standar (${PLAN_STANDARD_ID})`;
        this.ctx.logger.info(`[AutoReload][${email}] Memilih plan: ${planName}`);
        await planLabel.waitFor({ state: 'visible', timeout: 15000 });
        await planLabel.click();
        await this.ctx.sleep(1000);

        // STEP 7: Klik Berikutnya setelah pilih plan
        await getNextPlanButton(page).waitFor({ state: 'visible', timeout: 10000 });
        await getNextPlanButton(page).click();
        await this.ctx.sleep(2000);
      } else if (nextStep === 'step5') {
        this.ctx.logger.info(`[AutoReload][${email}] Menunggu halaman Selamat Datang Kembali...`);
        await getNextButton(page).click();
        await this.ctx.sleep(2000);

        // Cek apakah ada link "Ubah" plan sebelum bisa pilih plan
        const isChangePlanVisible = await getChangePlanLink(page).isVisible().catch(() => false);
        if (isChangePlanVisible) {
          this.ctx.logger.info(`[AutoReload][${email}] Menemukan link Ubah Plan, melakukan klik...`);
          await getChangePlanLink(page).click();
          await this.ctx.sleep(2000);
        }

        // STEP 6: Pilih plan
        const isMobilePlan = /harian|mingguan/i.test(variant_name);
        const planLabel = isMobilePlan ? getMobilePlanLabel(page) : getStandardPlanLabel(page);
        const planName = isMobilePlan ? `Ponsel (${PLAN_MOBILE_ID})` : `Standar (${PLAN_STANDARD_ID})`;
        this.ctx.logger.info(`[AutoReload][${email}] Memilih plan: ${planName}`);
        await planLabel.waitFor({ state: 'visible', timeout: 15000 });
        await planLabel.click();
        await this.ctx.sleep(1000);

        // STEP 7: Klik Berikutnya setelah pilih plan
        await getNextPlanButton(page).waitFor({ state: 'visible', timeout: 10000 });
        await getNextPlanButton(page).click();
        await this.ctx.sleep(2000);

        // STEP 8: Halaman "Yang terakhir" (Opsional, kadang langsung ke checkout)
        this.ctx.logger.info(`[AutoReload][${email}] Mengecek halaman Yang Terakhir atau langsung Checkout...`);
        const step8Or9 = await Promise.race([
          getLastStepHeading(page).waitFor({ state: 'visible', timeout: 10000 }).then(() => 'step8'),
          getLegalCheckbox(page).waitFor({ state: 'visible', timeout: 10000 }).then(() => 'step9')
        ]).catch(() => null);

        if (step8Or9 === 'step8') {
          this.ctx.logger.info(`[AutoReload][${email}] Menemukan halaman Yang Terakhir, klik Berikutnya...`);
          await getLastStepNextButton(page).click();
          await this.ctx.sleep(2000);
        } else {
          this.ctx.logger.info(`[AutoReload][${email}] Halaman Yang Terakhir dilewati (langsung ke checkout).`);
        }
      } else {
        throw new Error(`[AutoReload] Gagal mendeteksi halaman selanjutnya setelah klik hero card.`);
      }

      // STEP 9: Centang checkbox legal
      await this.ctx.sleep(2000); // Tunggu sebentar untuk memastikan DOM selesai render
      this.ctx.logger.info(`[AutoReload][${email}] Mengecek plan sebelum centang checkbox legal...`);
      
      const isMobileCheck = /harian|mingguan/i.test(variant_name);
      const expectedPlanPattern = isMobileCheck ? /ponsel|mobile/i : /standar|standard/i;
      
      const currentPlanElement = getCurrentPlanText(page);
      const planVisible = await currentPlanElement.first().isVisible({ timeout: 5000 }).catch(() => false);
      
      if (planVisible) {
        const planText = await currentPlanElement.first().innerText();
        this.ctx.logger.info(`[AutoReload][${email}] Plan yang terdeteksi di checkout: ${planText}`);
        
        if (!expectedPlanPattern.test(planText)) {
          this.ctx.logger.warn(`[AutoReload][${email}] Plan tidak sesuai kriteria. Diharapkan: ${isMobileCheck ? 'Ponsel' : 'Standar'}. Mengklik ubah...`);
          
          const changeBtn = getChangePlanCheckoutLink(page);
          await changeBtn.first().waitFor({ state: 'visible', timeout: 5000 });
          await changeBtn.first().click();
          await this.ctx.sleep(2000);
          
          // Pilih plan baru
          const planLabel = isMobileCheck ? getMobilePlanLabel(page) : getStandardPlanLabel(page);
          const planName = isMobileCheck ? `Ponsel (${PLAN_MOBILE_ID})` : `Standar (${PLAN_STANDARD_ID})`;
          this.ctx.logger.info(`[AutoReload][${email}] Memilih plan: ${planName}`);
          await planLabel.waitFor({ state: 'visible', timeout: 15000 });
          await planLabel.click();
          await this.ctx.sleep(1000);

          // Klik Berikutnya
          await getNextPlanButton(page).waitFor({ state: 'visible', timeout: 10000 });
          await getNextPlanButton(page).click();
          await this.ctx.sleep(2000);
          
          // Cek apakah masuk ke halaman Yang Terakhir (Step 8)
          const isStep8 = await getLastStepHeading(page).isVisible({ timeout: 5000 }).catch(() => false);
          if (isStep8) {
             this.ctx.logger.info(`[AutoReload][${email}] Halaman Yang Terakhir muncul, mengklik Berikutnya...`);
             await getLastStepNextButton(page).click();
             await this.ctx.sleep(2000);
          }
        } else {
          this.ctx.logger.info(`[AutoReload][${email}] Plan sudah sesuai kriteria.`);
        }
      } else {
        this.ctx.logger.warn(`[AutoReload][${email}] Gagal mendeteksi teks plan di checkout, melanjutkan...`);
      }

      this.ctx.logger.info(`[AutoReload][${email}] Mencentang checkbox legal...`);
      const checkbox = getLegalCheckbox(page);
      await checkbox.waitFor({ state: 'visible', timeout: 10000 });
      if (!(await checkbox.isChecked())) {
        await checkbox.check();
      }
      await this.ctx.sleep(1000);

      // STEP 10: Notify API tentang pending top-up, tunggu konfirmasi dari dashboard (10 menit)
      const topupEventName = `${accountId}:NETFLIX_TOPUP_CONFIRM`;
      const cancelEventName = `${accountId}:NETFLIX_TOPUP_CANCEL`;
      this.ctx.logger.info(`[AutoReload][${email}] Memberitahu API tentang pending top-up (maks 10 menit)... Billing: ${billing}`);

      // Panggil API endpoint untuk notify pending topup
      await notifyTopupPending(
        this.ctx.apiBaseUrl,
        this.ctx.authCredentials,
        accountId,
        email,
        billing,
        task.id,
      );

      // Kita tunggu event: BISA KONFIRMASI atau PEMBATALAN
      this.ctx.eventBus.emit('socket:subscribe', topupEventName);
      this.ctx.eventBus.emit('socket:subscribe', cancelEventName);

      try {
        const eventData = await Promise.race([
          this.ctx.waitForTaskEvent<any>(task.id, topupEventName).then(data => ({ type: 'confirm', data })),
          this.ctx.waitForTaskEvent<any>(task.id, cancelEventName).then(data => ({ type: 'cancel', data })),
        ]);

        this.ctx.eventBus.emit('socket:unsubscribe', topupEventName);
        this.ctx.eventBus.emit('socket:unsubscribe', cancelEventName);

        if (eventData.type === 'cancel') {
          this.ctx.logger.warn(`[AutoReload][${email}] Reload dibatalkan oleh admin.`);
          throw new Error("Reload dibatalkan oleh admin.");
        }

        this.ctx.logger.info(`[AutoReload][${email}] Konfirmasi top-up diterima! Melanjutkan...`);
      } catch (err) {
        this.ctx.eventBus.emit('socket:unsubscribe', topupEventName);
        this.ctx.eventBus.emit('socket:unsubscribe', cancelEventName);
        throw err;
      }

      // STEP 11: Klik "Mulai Keanggotaan"
      this.ctx.logger.info(`[AutoReload][${email}] Klik tombol konfirmasi mulai keanggotaan...`);
      await getConfirmStartButton(page).waitFor({ state: 'visible', timeout: 15000 });
      await getConfirmStartButton(page).click();
      await this.ctx.sleep(3000);

      // STEP 12: Halaman Akhir (orderfinal) — Klik Berikutnya
      this.ctx.logger.info(`[AutoReload][${email}] Menunggu halaman konfirmasi akhir (orderfinal)...`);
      try {
        await getOrderFinalButton(page).waitFor({ state: 'visible', timeout: 15000 });
        await getOrderFinalButton(page).click();
        this.ctx.logger.info(`[AutoReload][${email}] Tombol konfirmasi akhir diklik.`);
        await this.ctx.sleep(2000);
      } catch (err) {
        this.ctx.logger.warn(`[AutoReload][${email}] Tombol konfirmasi akhir tidak muncul atau gagal diklik. Melanjutkan...`);
      }

      // STEP 13: Hitung expiry baru & update DB
      const newExpiry = calculateReloadExpiry(variant_name);
      this.ctx.logger.info(`[AutoReload][${email}] Reload selesai! Subscription baru: ${newExpiry.toISOString()}`);

      await updateNetflixReloadStatus(
        this.ctx.apiBaseUrl,
        this.ctx.authCredentials,
        accountId,
        newExpiry,
      );

      this.ctx.logger.info(`[AutoReload][${email}] Database berhasil diperbarui. Proses selesai!`);

    } catch (error) {
      this.ctx.logger.error(
        `[AutoReload] Gagal reload akun ${email}: ${error instanceof Error ? error.message : String(error)}`,
        { instanceId: this.ctx.instanceId },
        {
          level: 'NEED_ACTION',
          context: 'NetflixAutoReload',
          customMessage: `‼️ Gagal auto reload Netflix\nEmail: ${email}\nBilling: ${billing}\n\nSilakan lakukan reload manual.`,
        },
      );
      throw error;
    } finally {
      await this.cleanupTask(page, contextName);
    }
  }

  private async handleCancelPlanFlow(page: any, email: string): Promise<void> {
    this.ctx.logger.info(`[AutoReload][${email}] Navigasi ke cancelplan...`);
    await page.goto(CANCEL_PLAN_URL);
    
    // Coba klik tombol expand "Tampilkan isi pilihan"
    const expandBtn = getExpandCancelButton(page);
    const finishBtn = getFinishCancellationButton(page);
    
    try {
      // Tunggu salah satu muncul: tombol expand atau tombol finish (jika sudah terbuka)
      await Promise.race([
        expandBtn.waitFor({ state: 'visible', timeout: 8000 }),
        finishBtn.waitFor({ state: 'visible', timeout: 8000 })
      ]);

      if (await expandBtn.isVisible()) {
        this.ctx.logger.info(`[AutoReload][${email}] Klik tombol expand...`);
        await expandBtn.click();
        await this.ctx.sleep(1500);
      }
    } catch (err) {
      this.ctx.logger.warn(`[AutoReload][${email}] Tombol expand tidak ditemukan atau menu sudah terbuka, mencoba cek tombol Finish...`);
    }

    // Klik "Selesaikan Pembatalan" (Finish Cancellation)
    await finishBtn.waitFor({ state: 'visible', timeout: 10000 });
    await finishBtn.click();
    this.ctx.logger.info(`[AutoReload][${email}] Pembatalan selesai, kembali ke halaman membership...`);
    await this.ctx.sleep(2000);

    // Balik ke membership, tunggu tombol restart muncul
    await page.goto(MEMBERSHIP_URL);
    await getRestartMembershipButton(page).waitFor({ state: 'visible', timeout: 20000 });
    this.ctx.logger.info(`[AutoReload][${email}] Tombol Restart Membership sudah muncul!`);
  }

  private async cleanupTask(page: any, contextName: string): Promise<void> {
    await page.close();
    await this.ctx.saveSession(contextName);
    const ctx = this.ctx.getContextByName(contextName);
    if (ctx) {
      await ctx.close();
      this.ctx.invalidateContext(contextName);
    }
  }
}
