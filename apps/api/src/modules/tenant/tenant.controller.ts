import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { PublicRoute } from 'src/guards/public-route.decorator';
import { VcAuthGuard } from 'src/guards/vc-auth.guard';
import { AtLeastOnePropertyPipe } from 'src/pipes/at-least-one-property.pipe';
import { PaginationProvider } from '../utility/pagination.provider';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { GetAllTenantQueryUrlDto } from './dto/get-all-tenant.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { TenantService } from './tenant.service';

@Controller('tenant')
export class TenantController {
  constructor(
    private readonly tenantService: TenantService,
    private readonly paginationProvider: PaginationProvider,
  ) {}

  @Get()
  findAll(@Query() query: GetAllTenantQueryUrlDto) {
    const { pagination, filter }
      = this.paginationProvider.separateUrlParameter(query);
    return this.tenantService.findAll(pagination, filter);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.tenantService.findOne(id);
  }

  @Post()
  create(@Body() createTenantDto: CreateTenantDto) {
    return this.tenantService.create(createTenantDto);
  }

  @Patch(':id')
  @UsePipes(AtLeastOnePropertyPipe)
  update(
    @Param('id') tenantId: string,
    @Body() updateTenantDto: UpdateTenantDto,
  ) {
    return this.tenantService.update(tenantId, updateTenantDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') tenantId: string) {
    return this.tenantService.remove(tenantId);
  }

  @UseGuards(VcAuthGuard)
  @Patch('owner/change-password')
  async changePassword(@Request() req: any, @Body() data: any) {
    const ownerId = req.user?.id;
    const currentSessionId = req.user?.session_id;
    return await this.tenantService.changePassword(ownerId, data, currentSessionId);
  }

  @UseGuards(VcAuthGuard)
  @Get('owner/device-sessions')
  getDeviceSessions(@Request() req: any) {
    return this.tenantService.getDeviceSessions(req.user.id);
  }

  @UseGuards(VcAuthGuard)
  @Post('owner/device-sessions/:sessionId/revoke')
  async revokeDeviceSession(@Request() req: any, @Param('sessionId') sessionId: string) {
    const ownerId = req.user?.id;
    return await this.tenantService.revokeDeviceSession(ownerId, sessionId);
  }

  @UseGuards(VcAuthGuard)
  @Get('owner/all-device-sessions')
  async getAllDeviceSessions(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    return await this.tenantService.getAllDeviceSessions(tenantId);
  }

  @UseGuards(VcAuthGuard)
  @Post('owner/all-device-sessions/:sessionId/revoke')
  async revokeAnyDeviceSession(@Request() req: any, @Param('sessionId') sessionId: string) {
    const tenantId = req.user?.tenant_id;
    return await this.tenantService.revokeAnyDeviceSession(tenantId, sessionId);
  }

  @UseGuards(VcAuthGuard)
  @Get('owner/billing-status')
  async getBillingStatus(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    return await this.tenantService.getBillingStatus(tenantId);
  }

  @UseGuards(VcAuthGuard)
  @Post('owner/renew-subscription')
  async renewSubscription(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    return await this.tenantService.renewSubscription(tenantId);
  }

  @PublicRoute()
  @Post('login')
  login(@Body() loginDto: LoginDto, @Request() req: any) {
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ip = req.ip || 'Unknown';
    return this.tenantService.login(loginDto, userAgent, ip);
  }
}
