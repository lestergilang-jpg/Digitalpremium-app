/**
 * ShopeeOrderModule - Module untuk memproses order baru di Shopee seller dashboard
 */

import type { Page } from "playwright";
import { errors as PlaywrightErrors } from "playwright";

import { BaseModule } from "../../core/BaseModule.js";
import type { ModuleDependencies } from "../../types/module.type.js";
import type { ModuleConfig } from "../../types/config.type.js";
import type { Task } from "../../types/task.type.js";
import { ElementNotFoundError } from "../../types/errors.js";
import {
  AlreadyProcessedError,
  NoProductBindError,
  NoAccountError,
  TransactionExistNoAccountError,
} from "./errors.js";
import {
  ORDER_LIST_URL,
  ORDER_DETAIL_URL,
  URL_PATTERNS,
  STATUS_PATTERNS,
  ORDER_CARD_ID_ATTRIBUTE,
} from "./constants.js";
import {
  checkProductNames,
  generateAccountTransaction,
  generateVoucherTransaction,
  copyAccountTemplate,
  fetchVoucherCopyTemplate,
  DEFAULT_VOUCHER_COPY_TEMPLATE,
} from "./api.js";

// Locators
import {
  getLoginKeyInput,
  getPasswordInput,
  getLoginButton,
  getLoginAlert,
  getLanguageSelectionModal,
  getBahasaIndonesiaButton,
} from "./locators/login.js";
import {
  getVerifyOpenModalButton,
  getVerifyByWhatsappButton,
} from "./locators/verify.js";
import {
  getOrderCards,
  getAccountInfo,
  getTerapkanButton,
} from "./locators/order-list.js";
import {
  getOrderStatus,
  getKirimButton,
  getAturPengirimanButton,
  getBuyerUsername,
  getProductList,
  getProductMeta,
  getProductName,
  getProductQty,
  getTotalPriceCard,
  getPriceAmount,
  getChatButton,
  getChatInput,
  getConfirmModal,
  getJKTAcceptButton,
  getJKPAcceptButton,
} from "./locators/order-detail.js";
import {
  TransactionAccountPayload,
  FailedAccountUser,
  AccountUser,
} from "./types/api.type.js";
import { ShopeeOrderConfig } from "./types/config.type.js";
import { OrderStatus, OrderRecord } from "./types/order.type.js";

// Constants
const VERIFY_TIMEOUT_MS = 600000; // 10 minutes
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_WAIT_TIME_MS = 2000;
const MAX_WAIT_TIME_MS = 8000;
const MAX_RETRY_ATTEMPT = 3;

export class ShopeeOrderModule extends BaseModule {
  private moduleConfig: ShopeeOrderConfig;
  private loopPage: Page | null = null;
  private voucherCopyTemplate: string = DEFAULT_VOUCHER_COPY_TEMPLATE;

  constructor(
    deps: ModuleDependencies,
    instanceId: string,
    config: ModuleConfig,
  ) {
    super(deps, instanceId, config);
    this.moduleConfig = config as unknown as ShopeeOrderConfig;
  }

  // ==========================================================================
  // Abstract method implementations
  // ==========================================================================

  async setupSchema(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        module_instance_id TEXT NOT NULL,
        orderId TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (orderId, module_instance_id)
      )
    `);
    this.logger.info("Database schema initialized");
  }

  async init(): Promise<void> {
    this.setRunning(true);
    // Ambil VOUCHER_COPY_TEMPLATE dari dashboard settings saat pertama kali init
    const fetchedTemplate = await fetchVoucherCopyTemplate(
      this.apiBaseUrl,
      this.authCredentials,
    );
    if (fetchedTemplate) {
      this.voucherCopyTemplate = fetchedTemplate;
      this.logger.info("Voucher copy template berhasil dimuat dari dashboard settings");
    } else {
      this.logger.info("VOUCHER_COPY_TEMPLATE tidak ditemukan di settings, menggunakan template default");
    }
    this.logger.info("ShopeeOrderModule initialized");
  }

  async stop(): Promise<void> {
    await this.cleanup();
    this.loopPage = null;
    this.logger.info("ShopeeOrderModule stopped");
  }

  // ==========================================================================
  // Loop handler
  // ==========================================================================

  async executeLoop(): Promise<void> {
    // Gunakan dedicated page untuk loop, buat baru jika belum ada atau sudah ditutup
    if (!this.loopPage || this.loopPage.isClosed()) {
      const context = await this.getOrCreateContext("shopee", { blockAssets: false });
      this.loopPage = await context.newPage();
      this.loopPage.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    }

    if (this.loopPage.url() === "about:blank") {
      await this.loopPage.goto(ORDER_LIST_URL);
      await this.sleep(2000);
    }

    // Check if on login this.loopPage
    if (this.loopPage.url().includes(URL_PATTERNS.LOGIN)) {
      try {
        await this.handleLogin(this.loopPage);
      } catch (error) {
        await this.requestStop((error as Error).message);
        this.logger.error(
          `Module akan dihentikan karena Shopee Gagal Login: ${(error as Error).message}`,
          {
            instanceId: this.instanceId,
          },
          {
            level: "ERROR",
            context: "ShopeeLogin",
            customMessage: `‼️ Shopee ${this.instanceId} pada bot akan dihentikan.\nTerjadi kegagalan saat login: ${(error as Error).message}`,
          },
        );
        throw error;
      }
    }

    // Check if on verify this.loopPage
    if (this.loopPage.url().includes(URL_PATTERNS.VERIFY)) {
      try {
        await this.handleVerify(this.loopPage);
      } catch (error) {
        await this.requestStop((error as Error).message);
        this.logger.error(
          `Module akan dihentikan karena Shopee Gagal Verify login: ${(error as Error).message}`,
          {
            instanceId: this.instanceId,
          },
          {
            level: "ERROR",
            context: "ShopeeLogin",
            customMessage: `‼️ Shopee ${this.instanceId} pada bot akan dihentikan.\nTerjadi kegagalan saat Verify login: ${(error as Error).message}`,
          },
        );
        throw error;
      }
    }

    // Ensure we're on order list this.loopPage after login/verify
    if (!this.loopPage.url().includes(URL_PATTERNS.NEW_ORDER_LIST)) {
      await this.loopPage.goto(ORDER_LIST_URL, {
        waitUntil: "domcontentloaded",
      });
    } else {
      // Get order cards
      const orderIds = await this.extractOrderIds(this.loopPage);

      if (orderIds.length > 0) {
        // Update status to queued
        for (const id of orderIds) {
          this.addNewOrder(id);
        }
      }

      // Refresh voucher copy template secara berkala dari dashboard settings
      const latestTemplate = await fetchVoucherCopyTemplate(
        this.apiBaseUrl,
        this.authCredentials,
      );
      if (latestTemplate && latestTemplate !== this.voucherCopyTemplate) {
        this.voucherCopyTemplate = latestTemplate;
        this.logger.info("Voucher copy template diperbarui dari dashboard settings");
      }

      // Claim queued orders before enqueueing so the same orderId is only scheduled once.
      const processableOrders = this.claimQueuedOrdersForEnqueue();
      for (const order of processableOrders) {
        this.enqueueTask("processOrder", {
          orderId: order.orderId,
          status: order.status,
        });
      }

      // Reload this.loopPage and wait before next loop
      await this.sleep(this.randBetween(MIN_WAIT_TIME_MS, MAX_WAIT_TIME_MS));
      await this.refreshOrderList(this.loopPage);
    }

    await this.sleep(1000);
  }

  // ==========================================================================
  // Task handlers
  // ==========================================================================

  async processOrder(task: Task): Promise<void> {
    const { orderId, status: initialStatus } = task.payload as {
      orderId: string;
      status: OrderStatus;
    };

    const currentOrder = this.getOrder(orderId);
    if (!currentOrder) {
      this.logger.warn(
        `Skipping order ${orderId}: order record tidak ditemukan`,
      );
      return;
    }

    if (currentOrder.status === "success" || currentOrder.status === "failed") {
      this.logger.info(
        `Skipping order ${orderId}: status sudah ${currentOrder.status}`,
      );
      return;
    }

    if (!this.claimOrderForProcessing(orderId)) {
      const latestStatus =
        this.getOrder(orderId)?.status || currentOrder.status;
      this.logger.info(
        `Skipping order ${orderId}: sudah diklaim task lain (status: ${latestStatus})`,
      );
      return;
    }

    this.logger.info(`Processing order ${orderId}`);

    let orderStatus = initialStatus;
    const context = await this.getOrCreateContext("shopee", { blockAssets: false });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    const orderUrl = ORDER_DETAIL_URL(orderId);
    await page.goto(orderUrl, { waitUntil: "domcontentloaded" });

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPT; attempt++) {
      try {
        // Check order status
        const orderState = await this.checkOrderState(page);

        if (orderState === "processed") {
          const stateText =
            (await getOrderStatus(page).textContent())?.trim() || "";
          if (!stateText) {
            throw new ElementNotFoundError("status pesanan tidak ditemukan");
          }
          if (
            STATUS_PATTERNS.ALREADY_PROCESSED.test(stateText) &&
            orderStatus !== "processing"
          ) {
            throw new AlreadyProcessedError("Pesanan telah diproses manual");
          }
          if (STATUS_PATTERNS.CANCELLED.test(stateText)) {
            throw new AlreadyProcessedError("Pesanan dibatalkan pembeli");
          }
        }

        // Get order data
        const username = await this.extractUsername(page, orderId);
        const products = await this.extractProducts(page);
        const totalPrice = await this.extractTotalPrice(page);

        // Process shipping if not already processing
        let jasaKirim = "";
        if (orderStatus !== "processing") {
          jasaKirim = await this.processShipping(page);
          this.updateOrderStatus(orderId, "processing");
          orderStatus = "processing";
        }

        // Reload and open chat
        await page.reload({ waitUntil: "domcontentloaded" });
        const chatInput = await this.ensureChatOpen(page);

        // Request accounts from server
        const platformProducts = await checkProductNames(
          this.apiBaseUrl,
          this.authCredentials,
          products.map((p) => ({ name: p.name, variant: p.variant })),
          this.instanceId,
        );
        const productList: { id: string; name: string; variant?: string }[] =
          [];

        for (const [index, pp] of platformProducts.entries()) {
          const sourceProduct = products[index];

          if (!pp.isFound) {
            this.logger.warn(
              `${orderId}: ${pp.name}${pp.variant ? ` (${pp.variant})` : ""} tidak terdaftar di produk platform aplikasi`,
            );
          } else if (!pp.product_variant_id) {
            this.logger.warn(
              `${orderId}: ${pp.name}${pp.variant ? ` (${pp.variant})` : ""} tidak memiliki product variant id`,
            );
          } else {
            for (let i = 0; i < sourceProduct.qty; i++) {
              productList.push({
                id: pp.product_variant_id,
                name: pp.name,
                variant: pp.variant,
              });
            }
          }
        }

        if (!productList.length) {
          throw new NoProductBindError(
            "Tidak ada nama produk yang terdaftar di produk platform aplikasi",
          );
        }

        const buyerWhatsapp = await this.extractBuyerWhatsapp(page);

        const transactionPayload: TransactionAccountPayload = {
          customer: username,
          platform: "Shopee",
          total_price: totalPrice,
          items: productList.map((p) => ({ product_variant_id: p.id })),
          store_name: this.instanceId,
          buyer_whatsapp: buyerWhatsapp,
        };

        // Build messages to send
        let messagesToSend: string[] = [];

        if (this.moduleConfig.delivery_mode === "voucher") {
          // JALUR VOUCHER

          // Loop products to generate vouchers (usually 1 per item)
          for (const p of productList) {
            const voucher = await generateVoucherTransaction(
              this.apiBaseUrl,
              this.authCredentials,
              {
                product_variant_id: p.id,
                buyer_name: username,
                buyer_whatsapp: buyerWhatsapp,
                buyer_email: "-", // Placeholder agar tidak error NotNull di database
                platform: "Shopee",
                price: totalPrice,
                prefix: "SHP-",
                store_name: this.instanceId,
              },
            );

            if (voucher && voucher.id) {
              const voucherMsg = this.formatVoucherMessage(
                voucher,
                `${p.name} ${p.variant || ""}`,
              );
              messagesToSend.push(voucherMsg);
            }
          }
        } else {
          // JALUR AKUN (DEFAULT)
          const generatedAccounts = await generateAccountTransaction(
            this.apiBaseUrl,
            this.authCredentials,
            orderId,
            transactionPayload,
          );

          for (const acc of generatedAccounts) {
            if ((acc as FailedAccountUser).availability_status) {
              const status =
                (acc as FailedAccountUser).availability_status === "COOLDOWN"
                  ? "COOLDOWN"
                  : "AKUN TIDAK TERSEDIA";
              this.logger.warn(
                `${orderId}: gagal generate akun untuk item ${(acc as FailedAccountUser).product_name}. status: ${status}`,
              );
            } else {
              const template = await copyAccountTemplate(
                (acc as AccountUser).profile,
                (acc as AccountUser).account,
                this.apiBaseUrl,
                this.authCredentials
              );
              if (template) messagesToSend.push(template);
            }
          }
        }

        if (!messagesToSend.length) {
          throw new NoAccountError(
            "Tidak ada akun atau voucher yang bisa dikirimkan",
          );
        }

        // Add before/after messages
        if (this.moduleConfig.message_before?.length) {
          messagesToSend = [
            ...this.moduleConfig.message_before,
            ...messagesToSend,
          ];
        }
        if (this.moduleConfig.message_after?.length) {
          messagesToSend = [
            ...messagesToSend,
            ...this.moduleConfig.message_after,
          ];
        }

        // Get Whatsapp module for dual sending
        const waModule = this.taskManager.getModuleInstanceByModuleName('whatsapp');

        // Send messages
        for (const msg of messagesToSend) {
          // 1. Send via Shopee Chat
          try {
            await chatInput.fill(msg);
            await page.keyboard.press("Enter");
          } catch (shopeeErr) {
            this.logger.warn(`${orderId}: Gagal mengetik di Shopee, tetap lanjut kirim ke WA... (${shopeeErr instanceof Error ? shopeeErr.message : shopeeErr})`);
          }
          
          // 2. Send via WhatsApp as Backup/Dual Broadcast
          if (buyerWhatsapp && waModule) {
            try {
              const waText = `[Notifikasi Pesanan Shopee]\n\n${msg}`;
              this.taskManager.enqueueTask({
                type: 'send_wa_message',
                moduleInstanceId: waModule.instanceId,
                payload: { phoneNumber: buyerWhatsapp, message: waText },
                source: 'INTERNAL'
              });
              this.logger.info(`${orderId}: Berhasil mendaftarkan antrean pesan WhatsApp untuk ${buyerWhatsapp}`);
            } catch (err) {
              this.logger.error(`${orderId}: Gagal mendaftarkan antrean WhatsApp: ${err instanceof Error ? err.message : err}`);
            }
          }

          await this.sleep(500);
        }

        this.updateOrderStatus(orderId, "success");
        this.logger.info(`Order ${orderId} berhasil diproses`);

        if (jasaKirim === "jkp") {
          this.logger.warn(
            `${orderId}: Jasa kirim toko tidak terdeteksi, silahkan chat CS shopee untuk pengiriman`,
            { instanceId: this.instanceId },
            {
              level: "NEED_ACTION",
              context: "ShopeeProcessOrder",
              customMessage: `⚠️ Jasa kirim toko tidak terdeteksi, silahkan chat CS shopee untuk pengiriman.\n\nProses order berhasil, perlu langkah manual untuk menyelesaikan pesananmu.\n\nOrder Id: ${orderId}\nUrl: ${orderUrl}`,
            },
          );
        }

        break;
      } catch (error) {
        const nonRetryError =
          error instanceof AlreadyProcessedError ||
          error instanceof NoAccountError ||
          error instanceof NoProductBindError ||
          error instanceof TransactionExistNoAccountError;

        if (!nonRetryError && attempt < MAX_RETRY_ATTEMPT) {
          this.logger.warn(
            `${orderId}: Mengulangi proses pesanan (${attempt}/${MAX_RETRY_ATTEMPT}): ${(error as Error).message}`,
          );
          const waitTime = this.jitter(400 * Math.pow(2, attempt - 1));
          await this.sleep(waitTime);
          await page.reload({ waitUntil: "domcontentloaded" });
          continue;
        }

        this.updateOrderStatus(orderId, "failed");
        this.logger.error(
          `${orderId}: Gagal memproses pesanan: ${(error as Error).message}`,
          { instanceId: this.instanceId },
          {
            level: "ERROR",
            context: "ShopeeProcessOrder",
            customMessage: `‼️ Gagal Memproses Pesanan Shopee: ${(error as Error).message}\n\nUrl Order: ${orderUrl}`,
          },
        );

        if (this.moduleConfig.message_fallback) {
          try {
            await page.reload({ waitUntil: "domcontentloaded" });
            const chatInput = await this.ensureChatOpen(page);
            await chatInput.fill(this.moduleConfig.message_fallback);
            await page.keyboard.press("Enter");
            await this.sleep(500);
          } catch {}
        }

        break;
      }
    }

    await page.close();
  }

  // ==========================================================================
  // Helper methods
  // ==========================================================================

  private async handleLogin(page: Page): Promise<void> {
    this.logger.info("Mencoba Login ke Shopee");

    await page.waitForLoadState("domcontentloaded");

    let isSelectLanguage = false;
    try {
      isSelectLanguage = await Promise.race([
        getLanguageSelectionModal(page)
          .waitFor({ state: "visible" })
          .then(() => true),
        getLoginButton(page)
          .waitFor({ state: "visible" })
          .then(() => false),
      ]);
    } catch {
      isSelectLanguage = false;
    }

    if (isSelectLanguage) {
      try {
        const selectLanguageModal = getLanguageSelectionModal(page);
        await getBahasaIndonesiaButton(selectLanguageModal).first().click();
        await this.sleep(1000);
      } catch (error) {
        throw new ElementNotFoundError(
          "Login Gagal: tombol bahasa indonesia tidak ditemukan",
        );
      }
    }

    try {
      await getLoginKeyInput(page).first().fill(this.moduleConfig.loginKey);
      await getPasswordInput(page).first().fill(this.moduleConfig.password);
      await getLoginButton(page).first().click();
    } catch (error) {
      throw new ElementNotFoundError(
        "Login Gagal: input loginKey, password, atau tombol login tidak ditemukan",
      );
    }

    // Wait for login result
    let afterLoginStatus = "";
    try {
      afterLoginStatus = await Promise.race([
        page
          .waitForURL((url) => url.pathname.includes(URL_PATTERNS.VERIFY))
          .then(() => "verify"),
        getAccountInfo(page)
          .waitFor({ state: "visible" })
          .then(() => "success"),
        getLoginAlert(page)
          .waitFor({ state: "visible" })
          .then(() => "error"),
      ]);
    } catch {
      throw new ElementNotFoundError("Login Gagal: status login tidak berubah");
    }

    if (afterLoginStatus === "verify") {
      await this.handleVerify(page);
    } else if (afterLoginStatus === "error") {
      const errorMessage =
        (await getLoginAlert(page).textContent())?.trim() || "Unknown error";
      throw new Error(`Login ke Shopee Gagal: ${errorMessage}`);
    }

    this.logger.info("Login ke Shopee Berhasil");
    await this.saveSession("shopee", true);
  }

  private async handleVerify(page: Page): Promise<void> {
    try {
      await getVerifyOpenModalButton(page).first().click();
      await getVerifyByWhatsappButton(page).first().click();
    } catch {
      throw new ElementNotFoundError(
        "Verify Gagal: modal untuk verify tidak ditemukan",
      );
    }

    // Wait for verify to complete (max 10 minutes)
    let elapsedTimeMs = 0;
    while (
      page.url().includes(URL_PATTERNS.VERIFY) &&
      elapsedTimeMs < VERIFY_TIMEOUT_MS
    ) {
      elapsedTimeMs += MIN_WAIT_TIME_MS;
      await this.sleep(MIN_WAIT_TIME_MS);
    }

    if (elapsedTimeMs >= VERIFY_TIMEOUT_MS) {
      throw new Error(
        "Verify Shopee Gagal: timeout lebih dari 10 menit tanpa tindakan",
      );
    }

    // Redirect ke order list jika belum di halaman yang benar
    if (!page.url().includes(URL_PATTERNS.NEW_ORDER_LIST)) {
      await page.goto(ORDER_LIST_URL, { waitUntil: "domcontentloaded" });
    }
  }

  private async extractOrderIds(page: Page): Promise<string[]> {
    const orderCards = getOrderCards(page);
    let orderIds: string[] = [];

    try {
      await orderCards
        .first()
        .waitFor({ state: "visible", timeout: MIN_WAIT_TIME_MS });
      const allOrderCards = await orderCards.all();
      const orderHrefs = await Promise.all(
        allOrderCards.map((locator) =>
          locator.getAttribute(ORDER_CARD_ID_ATTRIBUTE),
        ),
      );
      orderIds = orderHrefs
        .map((href) => (href ? href.trim().split("/").pop() : null))
        .filter((id): id is string => id !== null && id !== undefined);
    } catch (error) {
      if (!(error instanceof PlaywrightErrors.TimeoutError)) {
        this.logger.warn(`Order card error: ${(error as Error).message}`);
      }
    }

    return orderIds;
  }

  private async checkOrderState(
    page: Page,
  ): Promise<"jkt" | "jkp" | "processed"> {
    const orderStatusLocator = getOrderStatus(page);
    const kirimButton = getKirimButton(page);
    const aturPengirimanButton = getAturPengirimanButton(page);

    try {
      return await Promise.race([
        kirimButton.waitFor({ state: "visible" }).then(() => "jkt" as const),
        aturPengirimanButton
          .waitFor({ state: "visible" })
          .then(() => "jkp" as const),
        orderStatusLocator
          .waitFor({ state: "visible" })
          .then(() => "processed" as const),
      ]);
    } catch {
      throw new ElementNotFoundError(
        "tombol modal kirim atau status order tidak ditemukan",
      );
    }
  }

  private async extractUsername(page: Page, orderId: string): Promise<string> {
    try {
      const usernameLocator = getBuyerUsername(page);
      await usernameLocator.waitFor({ state: "attached" });
      return (await usernameLocator.textContent()) || orderId;
    } catch {
      this.logger.warn(
        `${orderId}: username tidak ditemukan, menggunakan order ID`,
      );
      return orderId;
    }
  }

  private async extractProducts(
    page: Page,
  ): Promise<{ name: string; qty: number; variant?: string }[]> {
    const productRowLocator = getProductList(page);

    try {
      await productRowLocator.first().waitFor({ state: "attached" });
    } catch {
      throw new ElementNotFoundError(
        "List produk di halaman pesanan tidak ditemukan",
      );
    }

    const allProductRows = await productRowLocator.all();

    if (!allProductRows.length) {
      throw new ElementNotFoundError(
        "List produk di halaman pesanan tidak ditemukan",
      );
    }

    const productsWithInvalid = await Promise.all(
      allProductRows.map(async (pr) => {
        const [productName, metaTexts, productQty] = await Promise.all([
          getProductName(pr)
            .first()
            .textContent({ timeout: 1000 })
            .catch(() => null),
          getProductMeta(pr)
            .allTextContents()
            .catch(() => []),
          getProductQty(pr)
            .first()
            .textContent({ timeout: 1000 })
            .catch(() => null),
        ]);

        let normalizedVariant: string | undefined;

        // Look for "Variasi:" or "Kode Variasi:"
        const variasi = metaTexts.find((t) =>
          t.trim().toLowerCase().startsWith("variasi:")
        );
        const kodeVariasi = metaTexts.find((t) =>
          t.trim().toLowerCase().startsWith("kode variasi:")
        );

        if (variasi) {
          normalizedVariant = variasi.replace(/^Variasi:\s*/i, "").trim();
        } else if (kodeVariasi) {
          normalizedVariant = kodeVariasi.replace(/^Kode Variasi:\s*/i, "").trim();
        }

        return {
          name: productName?.replace(/\s+/g, " ").trim() ?? "",
          variant: normalizedVariant,
          qty: productQty ? parseInt(productQty.trim().replace(/\D+/g, "")) : 0,
        };
      }),
    );

    const products = productsWithInvalid.filter((p) => !!p.name && p.qty > 0);

    if (!products.length) {
      throw new ElementNotFoundError(
        "nama atau qty dalam list produk tidak ditemukan",
      );
    }

    return products;
  }

  private async extractTotalPrice(page: Page): Promise<number> {
    const totalPriceCard = getTotalPriceCard(page);
    const priceLocator = getPriceAmount(totalPriceCard);

    try {
      await priceLocator.waitFor({ state: "attached" });
    } catch {
      throw new ElementNotFoundError("harga total pesanan tidak ditemukan");
    }

    return parseInt(
      (await priceLocator.textContent())?.replace(/\D+/g, "") || "0",
    );
  }

  private async processShipping(page: Page): Promise<"jkt" | "jkp"> {
    const kirimButton = getKirimButton(page);
    const aturPengirimanButton = getAturPengirimanButton(page);

    let jasaKirim: "jkt" | "jkp";

    try {
      jasaKirim = await Promise.race([
        kirimButton
          .first()
          .click()
          .then(() => "jkt" as const),
        aturPengirimanButton
          .first()
          .click()
          .then(() => "jkp" as const),
      ]);
    } catch {
      throw new ElementNotFoundError("tombol modal kirim tidak ditemukan");
    }

    // Click confirm button
    const confirmModalBox = getConfirmModal(page);
    const jktAccButton = getJKTAcceptButton(confirmModalBox);
    const jkpAccButton = getJKPAcceptButton(confirmModalBox);

    try {
      await Promise.race([
        jktAccButton.first().click(),
        jkpAccButton.first().click(),
      ]);
    } catch {
      throw new ElementNotFoundError("tombol konfirmasi kirim tidak ditemukan");
    }

    // Wait for modal to close
    if (jasaKirim === "jkt") {
      await Promise.race([
        jktAccButton.waitFor({ state: "hidden" }),
        this.sleep(MIN_WAIT_TIME_MS),
      ]);
    } else {
      await Promise.race([
        jkpAccButton.waitFor({ state: "hidden" }),
        this.sleep(MIN_WAIT_TIME_MS),
      ]);
    }

    return jasaKirim;
  }

  private async ensureChatOpen(page: Page) {
    try {
      await getChatButton(page).first().click();
    } catch {
      throw new ElementNotFoundError("tombol Chat Sekarang tidak ditemukan");
    }

    const chatInput = getChatInput(page);
    try {
      await chatInput.waitFor({ state: "visible" });
    } catch {
      throw new ElementNotFoundError(
        "input untuk mengirim chat tidak ditemukan",
      );
    }

    return chatInput;
  }

  private async refreshOrderList(page: Page) {
    try {
      await getTerapkanButton(page).first().click({ timeout: 2000 });
    } catch {
      await page.reload();
    }
  }

  private async extractBuyerWhatsapp(page: Page): Promise<string> {
    try {
      const contactLocator = page.locator(".buyer-contact-information div").first();
      if (await contactLocator.isVisible({ timeout: 3000 })) {
        const text = await contactLocator.innerText();
        const parts = text.split(",");
        if (parts.length > 1) {
          return parts[1].trim().replace(/\s+/g, "");
        }
      }
    } catch (e) {
      this.logger.warn(`Gagal mengambil nomor WA pembeli: ${(e as Error).message}`);
    }
    return "";
  }

  private formatVoucherMessage(voucher: any, productName: string): string {
    const expiryDate = new Date(voucher.expired_at).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    // Gunakan tenantId dari authCredentials agar seragam untuk semua toko
    const tenantSubdomain = this.authCredentials.tenantId;
    const redeemUrl = `${tenantSubdomain}.digitalpremium.id/redeem?code=${voucher.id}`;

    // Gunakan template dari dashboard settings (VOUCHER_COPY_TEMPLATE)
    // Placeholder: $$product, $$voucher, $$batasklaim, $$linkredeem
    return this.voucherCopyTemplate
      .replace(/\$\$product/g, productName)
      .replace(/\$\$voucher/g, voucher.id)
      .replace(/\$\$batasklaim/g, expiryDate)
      .replace(/\$\$linkredeem/g, redeemUrl);
  }

  // Database helpers
  private addNewOrder(orderId: string): void {
    this.db.run(
      `INSERT INTO orders (module_instance_id, orderId, status)
       VALUES (?, ?, ?)
       ON CONFLICT(orderId, module_instance_id)
       DO NOTHING`,
      [this.instanceId, orderId, "queued"],
    );
  }

  private updateOrderStatus(orderId: string, status: OrderStatus): void {
    this.db.run(
      `INSERT INTO orders (module_instance_id, orderId, status)
       VALUES (?, ?, ?)
       ON CONFLICT(orderId, module_instance_id)
       DO UPDATE SET status = excluded.status`,
      [this.instanceId, orderId, status],
    );
  }

  private claimQueuedOrdersForEnqueue(): OrderRecord[] {
    return this.db.transaction(() => {
      const queuedOrders = this.db.all<OrderRecord>(
        `SELECT * FROM orders
         WHERE module_instance_id = ?
         AND status = 'queued'`,
        [this.instanceId],
      );

      if (!queuedOrders.length) {
        return [];
      }

      this.db.run(
        `UPDATE orders
         SET status = 'enqueued'
         WHERE module_instance_id = ?
         AND status = 'queued'`,
        [this.instanceId],
      );

      return queuedOrders.map((order) => ({
        ...order,
        status: "enqueued" as const,
      }));
    });
  }

  private claimOrderForProcessing(orderId: string): boolean {
    const result = this.db.run(
      `UPDATE orders
       SET status = 'processing'
       WHERE module_instance_id = ?
       AND orderId = ?
       AND status = 'enqueued'`,
      [this.instanceId, orderId],
    );

    return result.changes > 0;
  }

  private getOrder(orderId: string): OrderRecord | undefined {
    return this.db.get<OrderRecord>(
      `SELECT * FROM orders
       WHERE module_instance_id = ?
       AND orderId = ?`,
      [this.instanceId, orderId],
    );
  }

  // Utility helpers
  private randBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private jitter(baseMs: number): number {
    return baseMs + Math.floor(Math.random() * baseMs * 0.5);
  }
}
