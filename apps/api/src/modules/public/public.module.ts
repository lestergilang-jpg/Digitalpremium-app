import { Module } from '@nestjs/common';
import { DatabaseModule } from 'src/database/database.module';
import { AccountModule } from '../account/account.module';
import { PromoModule } from '../promo/promo.module';
import { SocketModule } from '../socket/socket.module';
import { TaskQueueModule } from '../task-queue/task-queue.module';
import { TenantModule } from '../tenant/tenant.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

@Module({
  imports: [DatabaseModule, TenantModule, SocketModule, AccountModule, PromoModule, WhatsappModule, TaskQueueModule],
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
