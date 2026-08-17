import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { DEVICE_SESSION_REPOSITORY, TENANT_REPOSITORY } from 'src/constants/database.const';
import { DeviceSession } from 'src/database/models/device-session.model';
import { Tenant } from 'src/database/models/tenant.model';
import { PostgresProvider } from 'src/database/postgres.provider';
import { AppLoggerService } from 'src/modules/logger/logger.service';
import { TokenProvider } from 'src/modules/utility/token.provider';
import { IAccessTokenPayload } from 'src/types/access-token.type';
import { AppRequest } from 'src/types/app-request.type';
import { Roles } from 'src/types/roles.type';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { PUBLIC_ROUTE } from './public-route.decorator';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class VcAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private logger: AppLoggerService,
    private configService: ConfigService,
    private tokenProvider: TokenProvider,
    private readonly postgresProvider: PostgresProvider,
    @Inject(TENANT_REPOSITORY) private tenantRepository: typeof Tenant,
    @Inject(DEVICE_SESSION_REPOSITORY) private deviceSessionRepository: typeof DeviceSession,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic)
      return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const authHeader = req.headers.authorization as string;
    if (!authHeader) {
      throw new UnauthorizedException('Authorization header is missing');
    }

    // Format: VC {TOKEN}
    const [authType, token] = authHeader.split(' ');
    if (authType !== 'VC' || !token) {
      throw new UnauthorizedException('Invalid Authorization header format');
    }

    const tokenPayload
      = this.tokenProvider.decodeJwt<IAccessTokenPayload>(token);

    const rolesCheck = this.reflector.getAllAndOverride<Array<Roles>>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!!rolesCheck && rolesCheck.length) {
      const hasRole = rolesCheck.includes(tokenPayload.role);
      if (!hasRole) {
        throw new ForbiddenException('Action Forbidden');
      }
    }

    let tenant: Tenant | null = null;
    let session: any = null;

    if (tokenPayload.role !== 'ADMIN') {
      const transaction = await this.postgresProvider.transaction();
      try {
        await this.postgresProvider.setSchema('master', transaction);

        tenant = await this.tenantRepository.findOne({
          where: { id: tokenPayload.tenant_id },
          transaction,
        });

        if (!tokenPayload.session_id) {
          throw new UnauthorizedException('Session is legacy or invalid');
        }

        session = await this.deviceSessionRepository.findOne({
          where: { id: tokenPayload.session_id },
          transaction,
        });

        if (!session || session.is_revoked) {
          throw new UnauthorizedException('Session is revoked or invalid');
        }

        const now = new Date();
        if (now.getTime() - session.last_active_at.getTime() > 60000) {
          await session.update({ last_active_at: now }, { transaction });
        }

        await transaction.commit();
      }
      catch (error) {
        await transaction.rollback();
        this.logger.error(
          `Get Tenant from DB Error: ${(error as Error).message}`,
          (error as Error).stack,
          'VCAuthGuard',
        );
        if (error instanceof UnauthorizedException) {
          throw error;
        }
        throw new InternalServerErrorException(
          'Get tenant or session from database error',
        );
      }

      if (!tenant) {
        throw new UnauthorizedException('Invalid tenant');
      }

      const now = new Date();
      const isTrialActive = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) > now : false;
      const isSubscriptionActive = tenant.subscription_ends_at ? new Date(tenant.subscription_ends_at) > now : false;
      const isExpired = !isTrialActive && !isSubscriptionActive;

      if (isExpired) {
        const isBillingRoute = req.url.includes('/billing-status') || req.url.includes('/renew-subscription');
        if (!isBillingRoute) {
          throw new HttpException(
            {
              statusCode: 402,
              message: 'Masa aktif tenant telah habis. Silakan lakukan pembayaran untuk memperpanjang layanan.',
              error: 'Payment Required',
            },
            402
          );
        }
      }
    }

    const secret = this.configService.get<string>('token.secret');

    if (!secret) {
      throw new UnauthorizedException('Missing secret');
    }

    try {
      const payload = await this.tokenProvider.verifyJwt<IAccessTokenPayload>(
        secret,
        token,
      );

      req.user = payload;

      const tenant_id = req.headers['x-tenant-id'] as string;
      if (!tenant_id) {
        throw new NotFoundException('Missing tenant id');
      }

      if (payload.role !== 'ADMIN' && tenant_id !== payload.tenant_id) {
        throw new UnauthorizedException('Tenant mismatch');
      }

      req.tenant_id = tenant_id;
      req.user = payload;

      // TENANT_OWNER bypasses all permission checks
      if (payload.role === 'TENANT_OWNER') {
        return true;
      }

      // For DASHBOARD_USER, validate required permissions
      if (payload.role === 'DASHBOARD_USER') {
        const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
          PERMISSIONS_KEY,
          [context.getHandler(), context.getClass()],
        );

        if (requiredPermissions && requiredPermissions.length > 0) {
          const userPermissions = payload.permissions ?? [];
          const hasAllPermissions = requiredPermissions.every(p =>
            userPermissions.includes(p),
          );
          if (!hasAllPermissions) {
            throw new ForbiddenException('Insufficient permissions');
          }
        }
      }

      return true;
    }
    catch (e) {
      if (e instanceof NotFoundException) {
        throw e;
      }
      if (e instanceof ForbiddenException) {
        throw e;
      }
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
