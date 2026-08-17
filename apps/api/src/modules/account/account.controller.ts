import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UsePipes,
} from '@nestjs/common';
import { RequirePermissions } from 'src/guards/permissions.decorator';
import { AtLeastOnePropertyPipe } from 'src/pipes/at-least-one-property.pipe';
import { AppRequest } from 'src/types/app-request.type';
import { PaginationProvider } from '../utility/pagination.provider';
import { AccountService } from './account.service';
import { AddAccountCapitalDto } from './dto/add-account-capital.dto';
import { BulkCreateAccountDto } from './dto/bulk-create-account.dto';
import { CreateAccountDto } from './dto/create-account.dto';
import { FreezeAccountDto } from './dto/freeze-account.dto';
import { GetAllAccountQueryUrlDto } from './dto/get-all-account.dto';
import { MoveAccountUserDto } from './dto/move-account-user.dto';
import { UpdateAccountCapitalDto } from './dto/update-account-capital.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Controller('account')
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly paginationProvider: PaginationProvider,
  ) {}

  @Get()
  @RequirePermissions('account.view')
  findAll(
    @Query() query: GetAllAccountQueryUrlDto,
    @Request() request: AppRequest,
  ) {
    const { pagination, filter }
      = this.paginationProvider.separateUrlParameter(query);
    return this.accountService.findAll(request.tenant_id!, pagination, filter);
  }

  @Get('/count')
  @RequirePermissions('account.view')
  countStatusAccount(
    @Query('product_variant_id') productVariantId: string,
    @Query('product_id') productId: string,
    @Query('product_slug') productSlug: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.countStatusAccount(request.tenant_id!, {
      product_variant_id: productVariantId,
      product_id: productId,
      product_slug: productSlug,
    });
  }

  @Get('pending-topups')
  @RequirePermissions('account.view')
  getPendingTopups(@Request() request: AppRequest) {
    return this.accountService.getPendingTopups(request.tenant_id!);
  }

  @Get(':id')
  @RequirePermissions('account.view')
  findById(@Param('id') id: string, @Request() request: AppRequest) {
    return this.accountService.findOne(request.tenant_id!, id);
  }

  @Get(':id/financial-details')
  @RequirePermissions('account.view')
  getFinancialDetails(@Param('id') id: string, @Request() request: AppRequest) {
    return this.accountService.getFinancialDetails(request.tenant_id!, id);
  }

  @Get(':id/netflix-token')
  @RequirePermissions('account.view')
  getNetflixToken(@Param('id') id: string, @Request() request: AppRequest) {
    return this.accountService.getNetflixToken(request.tenant_id!, id);
  }

  @Post(':id/import-netflix-cookies')
  @RequirePermissions('account.view')
  importNetflixCookies(
    @Param('id') id: string, 
    @Body('cookies') cookies: any, 
    @Request() request: AppRequest
  ) {
    return this.accountService.importNetflixCookies(request.tenant_id!, id, cookies);
  }

  @Post(':id/sync-cookies-from-bot')
  @RequirePermissions('account.view')
  syncCookiesFromBot(
    @Param('id') id: string,
    @Body('email') email: string,
    @Body('botName') botName: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.syncCookiesFromBot(request.tenant_id!, email, botName, id);
  }

  @Post()
  @RequirePermissions('account.create')
  create(
    @Body() createAccountDto: CreateAccountDto,
    @Request() request: AppRequest,
  ) {
    return this.accountService.create(request.tenant_id!, createAccountDto);
  }

  @Post('bulk')
  @RequirePermissions('account.create')
  bulkCreate(
    @Body() bulkCreateDto: BulkCreateAccountDto,
    @Request() request: AppRequest,
  ) {
    return this.accountService.bulkCreate(request.tenant_id!, bulkCreateDto);
  }

  @Patch('bulk')
  @RequirePermissions('account.edit')
  bulkAction(
    @Body() body: { ids: string[]; action: any; payload?: any },
    @Request() request: AppRequest,
  ) {
    if (body.action === 'delete') {
      const user = request.user;
      if (user?.role === 'DASHBOARD_USER' && !user.permissions?.includes('account.delete')) {
        throw new ForbiddenException('Aksi ditolak: Anda tidak memiliki akses untuk menghapus akun.');
      }
    }
    return this.accountService.bulkAction(request.tenant_id!, body.ids, body.action, body.payload);
  }

  @Patch(':id')
  @UsePipes(AtLeastOnePropertyPipe)
  @RequirePermissions('account.edit')
  update(
    @Param('id') accountId: string,
    @Body() updateAccountDto: UpdateAccountDto,
    @Request() request: AppRequest,
  ) {
    return this.accountService.update(
      request.tenant_id!,
      accountId,
      updateAccountDto,
    );
  }

  @Patch(':id/freeze')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('account.edit')
  async freezeAccount(
    @Param('id') accountId: string,
    @Body() freezeAccountDto: FreezeAccountDto,
    @Request() request: AppRequest,
  ) {
    await this.accountService.freezeAccount(
      request.tenant_id!,
      accountId,
      freezeAccountDto,
    );
  }

  @Patch(':id/unfreeze')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('account.edit')
  async unfreezeAccount(
    @Param('id') accountId: string,
    @Request() request: AppRequest,
  ) {
    await this.accountService.clearFreezeAccount(request.tenant_id!, accountId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('account.delete')
  remove(@Param('id') accountId: string, @Request() request: AppRequest) {
    return this.accountService.remove(request.tenant_id!, accountId);
  }

  @Post(':id/capital')
  @RequirePermissions('account.edit')
  addCapital(
    @Param('id') id: string,
    @Body() addAccountCapitalDto: AddAccountCapitalDto,
    @Request() request: AppRequest,
  ) {
    return this.accountService.addCapital(
      request.tenant_id!,
      id,
      addAccountCapitalDto,
    );
  }

  @Patch(':id/capital/:capitalId')
  @RequirePermissions('account.edit')
  editCapital(
    @Param('id') id: string,
    @Param('capitalId') capitalId: string,
    @Body() updateAccountCapitalDto: UpdateAccountCapitalDto,
    @Request() request: AppRequest,
  ) {
    return this.accountService.editCapital(
      request.tenant_id!,
      id,
      capitalId,
      updateAccountCapitalDto,
    );
  }

  @Delete(':id/capital/:capitalId')
  @RequirePermissions('account.edit')
  deleteCapital(
    @Param('id') id: string,
    @Param('capitalId') capitalId: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.deleteCapital(
      request.tenant_id!,
      id,
      capitalId,
    );
  }

  @Post(':id/reset')
  @RequirePermissions('account.edit')
  resetAccount(
    @Param('id') id: string,
    @Body() body: { target_bot?: string },
    @Request() request: AppRequest,
  ) {
    return this.accountService.triggerReset(request.tenant_id!, id, body?.target_bot);
  }

  @Post(':id/reload')
  @RequirePermissions('account.edit')
  reloadAccount(
    @Param('id') id: string,
    @Body() body: { target_bot?: string },
    @Request() request: AppRequest,
  ) {
    return this.accountService.triggerReload(request.tenant_id!, id, body?.target_bot);
  }

  @Post(':id/upgrade')
  @RequirePermissions('account.edit')
  upgradeAccount(
    @Param('id') id: string,
    @Body() body: { target_bot?: string },
    @Request() request: AppRequest,
  ) {
    return this.accountService.triggerUpgrade(request.tenant_id!, id, body?.target_bot);
  }

  @Post(':id/login-tv')
  @RequirePermissions('account.edit')
  loginTv(
    @Param('id') id: string,
    @Body() body: { target_bot?: string },
    @Request() request: AppRequest,
  ) {
    return this.accountService.triggerLoginTv(request.tenant_id!, id, body?.target_bot);
  }

  @Post(':id/request-topup')
  @RequirePermissions('account.edit')
  requestTopup(
    @Param('id') id: string,
    @Body() body: { email: string; billing: string; taskId: string },
    @Request() request: AppRequest,
  ) {
    return this.accountService.registerPendingTopup(request.tenant_id!, id, body);
  }

  @Post(':id/labels')
  @RequirePermissions('account.edit')
  assignLabel(
    @Param('id') accountId: string,
    @Body() body: { label_id: string },
    @Request() request: AppRequest,
  ) {
    return this.accountService.assignLabel(request.tenant_id!, accountId, body.label_id);
  }

  @Delete(':id/labels/:labelId')
  @RequirePermissions('account.edit')
  unassignLabel(
    @Param('id') accountId: string,
    @Param('labelId') labelId: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.unassignLabel(request.tenant_id!, accountId, labelId);
  }

  @Post('users/:userId/move')
  @RequirePermissions('account.edit')
  moveAccountUser(
    @Param('userId') userId: string,
    @Body() payload: MoveAccountUserDto,
    @Request() request: AppRequest,
  ) {
    return this.accountService.moveAccountUser(request.tenant_id!, userId, payload);
  }

  @Get(':id/move-history')
  @RequirePermissions('account.view')
  getMoveHistory(
    @Param('id') accountId: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.getMoveHistory(request.tenant_id!, accountId);
  }

  @Get('product/:productId/move-history')
  @RequirePermissions('account.view')
  getMoveHistoryByProduct(
    @Param('productId') productId: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.getMoveHistoryByProduct(request.tenant_id!, productId);
  }

  @Get('users/:userId/move-recommendations')
  @RequirePermissions('account.view')
  getAccountUserMoveRecommendations(
    @Param('userId') userId: string,
    @Request() request: AppRequest,
  ) {
    return this.accountService.getAccountUserMoveRecommendations(request.tenant_id!, userId);
  }
}
