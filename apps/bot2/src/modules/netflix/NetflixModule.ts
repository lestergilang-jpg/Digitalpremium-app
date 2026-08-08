/**
 * Netflix Module — Refactored Version
 */

import { BaseModule } from "../../core/BaseModule.js";
import type { ModuleDependencies } from "../../types/module.type.js";
import type { ModuleConfig } from "../../types/config.type.js";
import type { Task } from "../../types/task.type.js";

import type { INetflixModuleContext } from "./interfaces/netflix-module.interface.js";
import type { BrowserContext } from "playwright";
import type { Logger } from "../../core/Logger.js";
import type { EventBus } from "../../core/EventBus.js";
import type { AuthCredentials } from "../../core/auth.js";

// Services
import { NetflixResetPasswordService } from "./services/NetflixResetPasswordService.js";
import { NetflixAutoReloadService } from "./services/NetflixAutoReloadService.js";
import { NetflixUpgradeService } from "./services/NetflixUpgradeService.js";
import { NetflixLoginTvService } from "./services/NetflixLoginTvService.js";
import { NetflixGetTokenService } from "./services/NetflixGetTokenService.js";

export class NetflixModule extends BaseModule {
  constructor(
    deps: ModuleDependencies,
    instanceId: string,
    config: ModuleConfig,
  ) {
    super(deps, instanceId, config);
  }


  async setupSchema(): Promise<void> {
    this.logger.info("NetflixModule schema setup (no-op)");
  }

  async init(): Promise<void> {
    this.setRunning(true);
    this.logger.info("NetflixModule initialized");
  }

  async stop(): Promise<void> {
    await this.cleanup();
    this.logger.info("NetflixModule stopped");
  }

  /**
   * TASK: Get Token
   */
  async getToken(task: Task): Promise<any> {
    const service = new NetflixGetTokenService(this as unknown as INetflixModuleContext);
    return await service.execute(task);
  }

  /**
   * TASK: Reset Password
   */
  async resetPassword(task: Task): Promise<void> {
    const service = new NetflixResetPasswordService(this as unknown as INetflixModuleContext);
    return await service.execute(task);
  }

  /**
   * TASK: Auto Reload Flow
   */
  async autoReload(task: Task): Promise<void> {
    const service = new NetflixAutoReloadService(this as unknown as INetflixModuleContext);
    return await service.execute(task);
  }

  /**
   * TASK: Auto Upgrade Plan ke Premium
   */
  async autoUpgradePlan(task: Task): Promise<void> {
    const service = new NetflixUpgradeService(this as unknown as INetflixModuleContext);
    return await service.execute(task);
  }

  /**
   * TASK: Login TV Flow
   */
  async loginTvFlow(task: Task): Promise<void> {
    const service = new NetflixLoginTvService(this as unknown as INetflixModuleContext);
    return await service.execute(task);
  }
}
