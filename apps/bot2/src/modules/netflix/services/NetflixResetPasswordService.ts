import { INetflixModuleContext } from "../interfaces/netflix-module.interface.js";
import type { Task } from "../../../types/task.type.js";
import { CHANGE_PASSWORD_URL, REQUEST_RESET_URL, LOGIN_PATH } from "../constants.js";
import { sanitizeEmail } from "../utils.js";
import { ResetPasswordPayload } from "../types/payload.type.js";
import { ResetPasswordEventData } from "../types/event.type.js";
import { updateNetflixAccountStatus } from "../api.js";
import { calculateAccountState, generateRandomPassword } from "../utils/netflix-helpers.js";
import { NetflixAuthService } from "./NetflixAuthService.js";

// Locators
import {
  getCurrentPasswordInput,
  getNewPasswordInput,
  getConfirmNewPasswordInput,
  getLogAllDevicesCheckbox,
  getSubmitButton,
  getCurrentPasswordError,
  getGenericErrorAlert,
  getMfaEmailButton,
  getOtpInput,
  getOtpSubmitButton,
} from "../locators/changePassword.js";
import {
  getEmailRadio,
  getEmailInput,
  getSendEmailButton,
  getResetErrorCallout,
} from "../locators/requestReset.js";

export class NetflixResetPasswordService {
  private authService: NetflixAuthService;

  constructor(private readonly ctx: INetflixModuleContext) {
    this.authService = new NetflixAuthService(ctx);
  }

  async execute(task: Task): Promise<void> {
    const payload = task.payload as unknown as ResetPasswordPayload;
    const email = payload.email;
    const password = payload.password;
    let newPassword = payload.newPassword;

    // Jika API tidak mengirim password baru, Bot buat sendiri (V3 Logic: 6 char, lower + numbers)
    if (!newPassword || newPassword.trim() === "") {
        newPassword = generateRandomPassword(6);
        this.ctx.logger.info(`No password provided from API, generated new one: ${newPassword}`);
    }

    const contextName = `${sanitizeEmail(email)}`;
    this.ctx.logger.info(
      `Starting reset password for ${email} with context ${contextName}`,
    );

    const context = await this.ctx.getOrCreateContext(contextName);
    const page = await context.newPage();

    try {
      await page.goto(CHANGE_PASSWORD_URL);
      this.ctx.logger.info(`[${email}] Checking auth state...`);

      let loginState = await this.authService.detectLoginState(page);

      // 2. Jika Belum Login, Coba Login Manual Dulu
      if (loginState === "not_logged_in") {
          this.ctx.logger.info(`[${email}] Not logged in, attempting manual login with existing password...`);
          const loginSuccess = await this.authService.attemptManualLogin(page, email, password);
          
          if (loginSuccess) {
              this.ctx.logger.info(`[${email}] Manual login successful, proceeding to change password`);
              await page.goto(CHANGE_PASSWORD_URL);
              loginState = await this.authService.detectLoginState(page);
          } else {
              this.ctx.logger.info(`[${email}] Manual login failed or not possible, falling back to email reset`);
          }
      }

      // 3. Skenario Reset / Change
      if (loginState === "not_logged_in") {
        await this.handleEmailResetFlow(page, task, email, newPassword);
      } else {
        const changeSuccess = await this.handleChangePasswordFlow(page, task, email, newPassword, password);
        if (!changeSuccess) {
            await this.handleEmailResetFlow(page, task, email, newPassword);
        }
      }

      await this.handlePostSubmission(page, email);
      this.ctx.logger.info(`[${email}] Password reset/change submitted successfully`);

      // 5. Update Status ke API (V3 Logic)
      const { status, reason } = calculateAccountState(payload.subscription_expiry);
      const variantName = payload.variant_name || '';
      const shouldSwitch = variantName.toLowerCase() !== 'harian' && variantName !== '';
      const variantLog = shouldSwitch ? `SWITCHED (${variantName} -> Harian)` : "TETAP (Harian)";

      this.ctx.logger.info(`RESET SUKSES | Email: ${email} | Pass: ${newPassword} | Status: ${status.toUpperCase()} (${reason}) | Variant: ${variantLog}`);

      await updateNetflixAccountStatus(
        this.ctx.apiBaseUrl,
        this.ctx.authCredentials,
        payload.accountId,
        newPassword,
        status,
        shouldSwitch
      );

    } catch (error) {
      await this.handleTaskError(error, email, newPassword);
      throw error; 
    } finally {
      await this.cleanupTask(page, contextName);
    }
  }

  private async handleEmailResetFlow(page: any, task: Task, email: string, newPassword: string): Promise<void> {
    this.ctx.logger.info(`[${email}] Proceeding with email reset flow...`);
    
    const eventName = `${sanitizeEmail(email)}:NETFLIX_REQ_RESET_PASSWORD`;
    this.ctx.eventBus.emit('socket:subscribe', eventName);

    // Mulai listen event SEBELUM klik (untuk menghindari race condition)
    const eventPromise = this.ctx.waitForTaskEvent<ResetPasswordEventData>(
      task.id,
      eventName,
    );

    try {
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            // Clear Cookies sebelum retry (jika bukan attempt pertama)
            if (attempt > 1) {
                this.ctx.logger.info(`[${email}] Attempt ${attempt}: Clearing cookies before retry...`);
                await page.goto("https://www.netflix.com/clearcookies");
                await this.ctx.sleep(2000);
            }

            await page.goto(REQUEST_RESET_URL);
            await this.ctx.sleep(1000);

            await getEmailRadio(page).click();
            await getEmailInput(page).fill(email);
            await getSendEmailButton(page).click();
            
            this.ctx.logger.info(`[${email}] Attempt ${attempt}: Waiting for response from Netflix (up to 10s)...`);

            // Cek apakah muncul pesan error "Terjadi Kesalahan" dengan waitFor
            const errorCallout = getResetErrorCallout(page).first();
            let hasError = false;
            try {
                await errorCallout.waitFor({ state: 'visible', timeout: 10000 });
                hasError = true;
            } catch (e) {
                hasError = false;
            }

            if (hasError) {
                const errorMsg = await errorCallout.innerText();
                this.ctx.logger.warn(`[${email}] Email reset attempt ${attempt} failed with error: "${errorMsg}".`);
                
                if (attempt === 3) {
                    this.ctx.logger.error(`[${email}] reset gagal terjadi kesalahan silahkan ambil link manual`);
                    throw new Error("reset gagal terjadi kesalahan silahkan ambil link manual");
                }
                continue;
            }

            success = true;
            break;
        }

        if (!success) return;

        this.ctx.logger.info(`[${email}] Reset email requested successfully, waiting for link from event...`);

        const eventData = await eventPromise;
        const resetLink = eventData.data;
        this.ctx.logger.info(`[${email}] Received reset link: ${resetLink}`);

        await page.goto(resetLink);
        await getNewPasswordInput(page).waitFor({ state: "visible", timeout: 30000 });

        await getNewPasswordInput(page).fill(newPassword);
        await getConfirmNewPasswordInput(page).fill(newPassword);

        const checkbox = getLogAllDevicesCheckbox(page);
        if (!(await checkbox.isChecked())) {
          await checkbox.check();
        }

        await getSubmitButton(page).click();
    } finally {
        this.ctx.eventBus.emit('socket:unsubscribe', eventName);
    }
  }

  private async handleChangePasswordFlow(page: any, task: Task, email: string, newPassword: string, password?: string, isRetry: boolean = false): Promise<boolean> {
    this.ctx.logger.info(`[${email}] Already logged in, proceeding to change password`);

    if (!password) {
      throw new Error("Current password is required for logged-in change password flow");
    }

    // Tunggu sampai salah satu input muncul (sandi lama ATAU sandi baru)
    const currentPasswordInput = getCurrentPasswordInput(page);
    const newPasswordInput = getNewPasswordInput(page);
    
    try {
      await Promise.race([
        currentPasswordInput.waitFor({ state: "visible", timeout: 15000 }),
        newPasswordInput.waitFor({ state: "visible", timeout: 15000 }),
      ]);
    } catch (e) {
      this.ctx.logger.warn(`[${email}] Timeout menunggu form change password muncul.`);
    }

    if (await currentPasswordInput.isVisible()) {
      this.ctx.logger.info(`[${email}] Input sandi lama terdeteksi, memasukkan sandi lama.`);
      await currentPasswordInput.fill(password);
    } else {
      this.ctx.logger.info(`[${email}] Input sandi lama tidak ada, langsung memasukkan sandi baru.`);
    }

    await newPasswordInput.fill(newPassword);
    await getConfirmNewPasswordInput(page).fill(newPassword);

    const checkbox = getLogAllDevicesCheckbox(page);
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }

    await getSubmitButton(page).click();

    const genericError = getGenericErrorAlert(page);
    try {
        await genericError.waitFor({ state: 'visible', timeout: 8000 });
        const errorText = await genericError.innerText();
        this.ctx.logger.warn(`[${email}] Terdeteksi error: "${errorText}". Melakukan verifikasi MFA...`);
        
        // 1. Redirect to manageaccountaccess
        await page.goto("https://www.netflix.com/manageaccountaccess");
        
        // 2. Click Kirim kode melalui email
        const mfaBtn = getMfaEmailButton(page);
        await mfaBtn.waitFor({ state: 'visible', timeout: 15000 });
        await mfaBtn.click();
        
        // 3. Tunggu kode OTP
        const otpEventName = `${sanitizeEmail(email)}:NETFLIX_OTP`;
        this.ctx.eventBus.emit('socket:subscribe', otpEventName);
        this.ctx.logger.info(`[${email}] Menunggu OTP dari email...`);
        
        try {
            this.ctx.logger.info(`[${email}] Menunggu OTP dari email (Filter: Verification Code)...`);
            
            let otpCode = '';
            // Kita tunggu sampai mendapatkan subject yang benar (Whitelist)
            while (!otpCode) {
                const eventData = await this.ctx.waitForTaskEvent<any>(task.id, otpEventName);
                const subject = (eventData.subject || "").toLowerCase();
                
                this.ctx.logger.info(`[${email}] Menerima email untuk OTP dengan subject: "${eventData.subject}"`);

                if (subject.includes("your verification code") || subject.includes("kode verifikasimu")) {
                    otpCode = eventData.data;
                    this.ctx.logger.info(`[${email}] OTP VALID ditemukan: ${otpCode}. Memasukkan kode...`);
                } else if (subject.includes("kode masukmu") || subject.includes("login code")) {
                    this.ctx.logger.warn(`[${email}] Subject "${eventData.subject}" diabaikan (Email Login Link). Menunggu email OTP Verifikasi yang benar...`);
                    // Loop berlanjut, waitForTaskEvent akan menunggu event socket berikutnya
                } else {
                    this.ctx.logger.warn(`[${email}] Subject "${eventData.subject}" tidak sesuai kriteria. Menunggu email OTP...`);
                }
            }
            
            // 4. Input OTP
            const otpInput = getOtpInput(page);
            await otpInput.waitFor({ state: 'visible', timeout: 15000 });
            await otpInput.fill(otpCode);
            
            // 5. Submit OTP
            await getOtpSubmitButton(page).click();
            await this.ctx.sleep(3000); // Tunggu proses verifikasi selesai
            
            this.ctx.logger.info(`[${email}] OTP berhasil disubmit, mengulangi proses ganti sandi...`);
            
            // 6. Redirect kembali ke halaman ganti sandi dan coba lagi (hanya 1 kali retry untuk mencegah infinite loop)
            if (!isRetry) {
                await page.goto(CHANGE_PASSWORD_URL);
                return await this.handleChangePasswordFlow(page, task, email, newPassword, password, true);
            } else {
                this.ctx.logger.error(`[${email}] Gagal mengganti sandi meskipun sudah diverifikasi OTP.`);
                return false;
            }
            
        } finally {
            this.ctx.eventBus.emit('socket:unsubscribe', otpEventName);
        }
        
    } catch (e) {
        // Tidak ada generic error, lanjut cek error password salah
    }

    // Check for "Incorrect password" error (Fallback V4)
    const errorEl = getCurrentPasswordError(page);
    try {
        await errorEl.waitFor({ state: 'visible', timeout: 5000 });
        const errorText = await errorEl.innerText();
        if (errorText.toLowerCase().includes('incorrect') || errorText.toLowerCase().includes('salah')) {
            this.ctx.logger.warn(`[${email}] Ganti password gagal karena password lama SALAH. Mencoba alur RESET EMAIL sebagai cadangan...`);
            return false;
        }
    } catch (e) {
        // Tidak ada error terlihat dalam 5 detik, anggap berhasil submit
    }

    return true;
  }

  private async handlePostSubmission(page: any, email: string): Promise<void> {
    this.ctx.logger.info(`[${email}] Waiting for Netflix to confirm password change...`);
    try {
      // Tunggu sampai salah satu indikator sukses muncul
      await Promise.race([
        page.waitForURL((url: any) => url.toString().includes('addphone'), { timeout: 30000 }),
        page.waitForURL((url: any) => url.toString().includes('passwordUpdated=success'), { timeout: 30000 }),
        page.waitForURL((url: any) => url.toString().includes('YourAccount'), { timeout: 30000 }),
        page.waitForURL((url: any) => url.toString().includes('browse'), { timeout: 30000 }),
        page.waitForSelector('text="Tidak, Terima Kasih", text="No Thanks", text="Not Now"', { timeout: 30000 }),
      ]).catch(() => this.ctx.logger.warn(`[${email}] Timeout waiting for redirect, checking current state...`));

      const currentUrl = page.url();
      this.ctx.logger.info(`[${email}] Current page after submit: ${currentUrl}`);

      // Jika masih di halaman password dan ada pesan error, berarti gagal
      if (currentUrl.includes('/password')) {
        const errorMsg = await getGenericErrorAlert(page).isVisible() ? await getGenericErrorAlert(page).innerText() : "";
        if (errorMsg) {
            throw new Error(`Gagal ganti password, masih tertahan di halaman /password dengan error: ${errorMsg}`);
        }
      }

      // 1. Handle prompt "Add Recovery Phone" atau "No Thanks"
      const noThanksBtn = page.locator('button:has-text("Tidak, Terima Kasih"), a:has-text("Tidak, Terima Kasih"), button:has-text("No Thanks"), button:has-text("Not Now")');
      if (await noThanksBtn.isVisible({ timeout: 5000 })) {
        this.ctx.logger.info(`[${email}] Handling 'Add Recovery Phone' prompt...`);
        await noThanksBtn.click();
        await this.ctx.sleep(3000);
      }

      // 2. Verifikasi jika mendarat di halaman keamanan/akun
      if (page.url().includes('passwordUpdated=success') || page.url().includes('security')) {
          this.ctx.logger.info(`[${email}] Verifying successful redirect to security page...`);
          const deviceLabel = page.locator('[data-uia="account-security-page+security-card+devices+item+label"]');
          if (await deviceLabel.isVisible({ timeout: 5000 })) {
              await deviceLabel.click();
              this.ctx.logger.info(`[${email}] Final verification click performed.`);
          }
      }
    } catch (err) {
      this.ctx.logger.warn("Post-submission verification finished with notice: " + (err instanceof Error ? err.message : String(err)));
    }
    await this.ctx.sleep(5000); 
  }

  private async notifyApiSuccess(payload: any, email: string, newPassword: string): Promise<void> {
    try {
        if (!payload.accountId) {
          throw new Error("Netflix reset payload missing accountId");
        }
        await updateNetflixAccountStatus(
          this.ctx.apiBaseUrl,
          this.ctx.authCredentials,
          payload.accountId,
          payload.newPassword,
        );
      } catch (error) {
        this.ctx.logger.error(
          `Berhasil reset netflix password pada ${email} tapi gagal update data app: ${error instanceof Error ? error.message : String(error)}`,
          { instanceId: this.ctx.instanceId },
          {
            level: "NEED_ACTION",
            context: "ResetNetflixPassword",
            customMessage: `⚠️ Berhasil reset password netflix\ntapi gagal update data di app\n\nEmail: ${email}\nPassword baru: ${newPassword}`,
          },
        );
      }
  }

  private async handleTaskError(error: any, email: string, newPassword: string): Promise<void> {
      this.ctx.logger.error(
        `Failed to reset netflix password for ${email}: ${error instanceof Error ? error.message : String(error)}`,
        { instanceId: this.ctx.instanceId },
        {
          level: "NEED_ACTION",
          context: "ResetNetflixPassword",
          customMessage: `‼️ Gagal reset password netflix pada email ${email}\n\nSilahkan lakukan reset manual.`,
        },
      );
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
