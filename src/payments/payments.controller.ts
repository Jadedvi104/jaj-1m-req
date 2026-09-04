import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { PaymentsService } from './payments.service';

@Controller('webhooks/kbank')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  @Post('payments')
  confirm(
    @Body() dto: ConfirmPaymentDto,
    @Headers('x-webhook-token') supplied = '',
  ) {
    const expected = this.config.getOrThrow<string>('KBANK_WEBHOOK_TOKEN');
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new UnauthorizedException();
    return this.payments.confirm(dto);
  }
}
