import { INetflixModuleContext } from "../interfaces/netflix-module.interface.js";
import type { Task } from "../../../types/task.type.js";
import { LOGIN_PATH } from "../constants.js";
import { sanitizeEmail } from "../utils.js";
import { TV_LOGIN_LOCATORS } from "../locators/login-tv.js";
import { NetflixAuthService } from "./NetflixAuthService.js";

export class NetflixLoginTvService {
  private authService: NetflixAuthService;

  constructor(private readonly ctx: INetflixModuleContext) {
    this.authService = new NetflixAuthService(ctx);
  }

  private logTvProgress(task: Task, accountId: string, email: string, message: string) {
    this.ctx.logger.info(`[LoginTV][${email}] ${message}`);
    this.ctx.eventBus.emit('socket:bot-tv-progress', {
      taskId: task.id,
      accountId,
      message,
    });
  }

  async execute(task: Task): Promise<void> {
    const payload = task.payload as any;
    const { email, password, accountId } = payload;
    const contextName = sanitizeEmail(email);

    this.logTvProgress(task, accountId, email, "Memulai proses login TV dengan Token...");

    const context = await this.ctx.getOrCreateContext(contextName);
    const page = await context.newPage();

    try {
      const cookies = await context.cookies();
      const netflixIdCookie = cookies.find((c: any) => c.name === 'NetflixId');
      const secureNetflixIdCookie = cookies.find((c: any) => c.name === 'SecureNetflixId');
      const nfvdidCookie = cookies.find((c: any) => c.name === 'nfvdid');

      if (!netflixIdCookie) {
        this.ctx.eventBus.emit('socket:bot-tv-pin-error', {
          taskId: task.id,
          message: "Cookies tidak valid silahkan import cookies manual terlebih dahulu",
        });
        throw new Error("Cookie 'NetflixId' tidak ditemukan di sesi bot.");
      }

      // Construct cookie header
      const cookieStrings: string[] = [];
      if (netflixIdCookie) cookieStrings.push(`NetflixId=${netflixIdCookie.value}`);
      if (secureNetflixIdCookie) cookieStrings.push(`SecureNetflixId=${secureNetflixIdCookie.value}`);
      if (nfvdidCookie) cookieStrings.push(`nfvdid=${nfvdidCookie.value}`);
      const cookieHeader = cookieStrings.join('; ');

      // Fetch nftoken using iOS FTL API
      const QUERY_PARAMS: Record<string, string> = {
        "appVersion": "15.48.1",
        "config": '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
        "device_type": "NFAPPL-02-",
        "esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
        "idiom": "phone",
        "iosVersion": "15.8.5",
        "isTablet": "false",
        "languages": "en-US",
        "locale": "en-US",
        "maxDeviceWidth": "375",
        "model": "saget",
        "modelType": "IPHONE8-1",
        "odpAware": "true",
        "path": '["account","token","default"]',
        "pathFormat": "graph",
        "pixelDensity": "2.0",
        "progressive": "false",
        "responseFormat": "json"
      };

      const urlObj = new URL("https://ios.prod.ftl.netflix.com/iosui/user/15.48");
      for (const [k, v] of Object.entries(QUERY_PARAMS)) {
        urlObj.searchParams.set(k, v);
      }

      const headers = {
        "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
        "x-netflix.request.attempt": "1",
        "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
        "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
        "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
        "x-netflix.context.app-version": "15.48.1",
        "x-netflix.argo.translated": "true",
        "x-netflix.context.form-factor": "phone",
        "x-netflix.context.sdk-version": "2012.4",
        "x-netflix.client.appversion": "15.48.1",
        "x-netflix.context.max-device-width": "375",
        "x-netflix.context.ab-tests": "",
        "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
        "x-netflix.client.type": "argo",
        "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
        "x-netflix.context.locales": "en-US",
        "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
        "x-netflix.client.iosversion": "15.8.5",
        "accept-language": "en-US;q=1",
        "x-netflix.argo.abtests": "",
        "x-netflix.context.os-version": "15.8.5",
        "x-netflix.request.client.context": '{"appState":"foreground"}',
        "x-netflix.context.ui-flavor": "argo",
        "x-netflix.argo.nfnsm": "9",
        "x-netflix.context.pixel-density": "2.0",
        "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
        "x-netflix.request.client.timezoneid": "Asia/Dhaka",
        "Cookie": cookieHeader
      };

      const fetchResponse = await fetch(urlObj.toString(), {
        method: "GET",
        headers: headers
      });

      if (!fetchResponse.ok) {
        this.ctx.eventBus.emit('socket:bot-tv-pin-error', {
          taskId: task.id,
          message: "Cookies tidak valid silahkan import cookies manual terlebih dahulu",
        });
        throw new Error(`Gagal memanggil FTL API: ${fetchResponse.status}`);
      }

      const resJson = (await fetchResponse.json()) as any;
      const nfToken = resJson?.value?.account?.token?.default?.token;

      if (!nfToken) {
        this.ctx.eventBus.emit('socket:bot-tv-pin-error', {
          taskId: task.id,
          message: "Cookies tidak valid silahkan import cookies manual terlebih dahulu",
        });
        throw new Error("Token tidak ditemukan di balasan FTL API.");
      }

      const tvLink = `https://www.netflix.com/tv2?nftoken=${encodeURIComponent(nfToken)}`;
      
      this.logTvProgress(task, accountId, email, "Navigasi langsung ke halaman input kode TV...");
      await page.goto(tvLink);
      await this.ctx.sleep(3000);

      // Cek apakah cookies dianggap expired/minta login
      if (page.url().includes(LOGIN_PATH) || (await this.authService.detectLoginState(page)) === "not_logged_in") {
        this.ctx.eventBus.emit('socket:bot-tv-pin-error', {
          taskId: task.id,
          message: "Cookies tidak valid silahkan import cookies manual terlebih dahulu",
        });
        throw new Error("Cookies tidak valid, sesi login ditolak.");
      }

      // Tunggu elemen input PIN muncul
      this.logTvProgress(task, accountId, email, "Menunggu form PIN muncul di netflix.com/tv2...");
      await page.waitForSelector(TV_LOGIN_LOCATORS.PIN_INPUTS, { timeout: 30000 });

      // Beritahu Dashboard bahwa Bot siap menerima PIN (Loop hingga 3x)
      let maxRetries = 3;
      let success = false;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Jika ini retry, reload halaman TV2
        if (attempt > 1) {
          this.logTvProgress(task, accountId, email, `Mereload halaman untuk percobaan ke-${attempt}...`);
          await page.goto(tvLink);
          await this.ctx.sleep(3000);
        }

        this.ctx.eventBus.emit('socket:bot-awaiting-tv-pin', {
          taskId: task.id,
          accountId,
        });

        // Tunggu PIN dari Dashboard (Timeout 5 menit)
        const pinEventName = `${this.ctx.instanceId}:dashboard-send-tv-pin`;
        const cancelEventName = `${this.ctx.instanceId}:dashboard-cancel-tv-pin`;
        this.logTvProgress(task, accountId, email, `Menunggu PIN dari dashboard [Attempt ${attempt}/${maxRetries}]...`);
        
        this.ctx.eventBus.emit('socket:subscribe', cancelEventName);

        const eventData = await Promise.race([
          this.ctx.waitForTaskEvent<{ pin: string }>(task.id, pinEventName).then(data => ({ type: 'pin', data })),
          this.ctx.waitForTaskEvent<any>(task.id, cancelEventName).then(data => ({ type: 'cancel', data }))
        ]);

        this.ctx.eventBus.emit('socket:unsubscribe', cancelEventName);

        if (eventData.type === 'cancel') {
          this.logTvProgress(task, accountId, email, "Proses dibatalkan oleh pengguna.");
          throw new Error("Login TV dibatalkan oleh pengguna.");
        }

        const pin = eventData.data.pin;

        if (!pin || pin.length !== 8) {
          if (attempt === maxRetries) {
            throw new Error("PIN yang diterima tidak valid (harus 8 digit)");
          } else {
            this.logTvProgress(task, accountId, email, "PIN tidak valid. Mengulangi...");
            continue;
          }
        }

        this.logTvProgress(task, accountId, email, `PIN diterima. Memasukkan PIN ke Netflix...`);

        // Masukkan PIN satu per satu
        const inputs = page.locator(TV_LOGIN_LOCATORS.PIN_INPUTS);
        for (let i = 0; i < 8; i++) {
          await inputs.nth(i).click();
          await page.keyboard.type(pin[i], { delay: 150 });
        }

        await this.ctx.sleep(1000);
        await page.locator(TV_LOGIN_LOCATORS.SUBMIT_BUTTON).click();
        this.logTvProgress(task, accountId, email, "PIN disubmit, menunggu verifikasi...");

        // Tunggu hasil
        try {
          await Promise.race([
            page.waitForURL(url => url.toString().includes('/tv/out/success'), { timeout: 30000 }),
            page.waitForSelector(TV_LOGIN_LOCATORS.ERROR_MESSAGE, { timeout: 30000 }),
            page.waitForURL(url => url.toString().includes(LOGIN_PATH), { timeout: 30000 }),
          ]);
        } catch (e) {
          this.ctx.logger.warn(`[LoginTV][${email}] Timeout menunggu verifikasi PIN. Memeriksa URL saat ini...`);
        }

        // Cek apakah cookies dianggap expired/minta login setelah input PIN
        if (page.url().includes(LOGIN_PATH)) {
          this.ctx.eventBus.emit('socket:bot-tv-pin-error', {
            taskId: task.id,
            message: "Cookies tidak valid silahkan import cookies manual terlebih dahulu",
          });
          throw new Error("Diminta login ulang (Cookies kadaluarsa).");
        }

        if (page.url().includes('/tv/out/success')) {
          this.logTvProgress(task, accountId, email, "Login TV Berhasil! Memfinalisasi...");
          
          const finalBtn = page.locator(TV_LOGIN_LOCATORS.GO_TO_NETFLIX_BUTTON);
          if (await finalBtn.isVisible()) {
            await finalBtn.click();
            await this.ctx.sleep(2000);
          }

          this.ctx.eventBus.emit('socket:bot-tv-login-success', {
            taskId: task.id,
            accountId,
          });
          this.logTvProgress(task, accountId, email, "Proses Login TV selesai sepenuhnya.");
          
          success = true;
          break;
        } else {
          const errorMsg = await page.locator(TV_LOGIN_LOCATORS.ERROR_MESSAGE).isVisible() 
            ? await page.locator(TV_LOGIN_LOCATORS.ERROR_MESSAGE).innerText() 
            : "PIN salah atau terjadi kesalahan pada Netflix.";
          
          this.ctx.eventBus.emit('socket:bot-tv-pin-error', {
            taskId: task.id,
            message: errorMsg,
          });
          
          if (attempt === maxRetries) {
            throw new Error(`Login TV Gagal setelah ${maxRetries} percobaan: ${errorMsg}`);
          } else {
            this.logTvProgress(task, accountId, email, `Percobaan PIN salah (${attempt}/${maxRetries}): ${errorMsg}`);
          }
        }
      }
      
      if (!success) {
        throw new Error("Gagal login TV setelah maksimal percobaan.");
      }

    } catch (error) {
      this.ctx.logger.error(`[LoginTV][${email}] Error: ${error instanceof Error ? error.message : String(error)}`);
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
