import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto, @Headers('idempotency-key') key: string) {
    return this.orders.create(dto, key);
  }

  @Get(':reference')
  find(@Param('reference', ParseUUIDPipe) reference: string) {
    return this.orders.findPublic(reference);
  }

  @Patch(':reference/extend')
  extend(@Param('reference', ParseUUIDPipe) reference: string) {
    return this.orders.extend(reference);
  }
}
