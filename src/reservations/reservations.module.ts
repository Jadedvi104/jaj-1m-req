import { Module } from '@nestjs/common';
import { ReservationExpirerService } from './reservation-expirer.service';

@Module({ providers: [ReservationExpirerService] })
export class ReservationsModule {}
