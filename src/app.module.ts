import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging/messaging.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { ReservationsModule } from './reservations/reservations.module';
import { TableSessionsModule } from './table-sessions/table-sessions.module';
import { ProductsModule } from './products/products.module';
import { RedisModule } from './redis/redis.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    OrdersModule,
    PaymentsModule,
    ReservationsModule,
    TableSessionsModule,
    MessagingModule,
    HealthModule,
    RedisModule,
    UsersModule,
    ProductsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
