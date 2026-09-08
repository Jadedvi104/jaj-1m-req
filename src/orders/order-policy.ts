import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CreateOrderDto } from './dto/create-order.dto';

export const MAX_ORDER_ITEMS = 100;
export const MAX_ITEM_QUANTITY = 1000;
export const MAX_SATANG = 2_147_483_647;

export function validateOrderRequest(dto: CreateOrderDto, key: string): void {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key must be 1–128 visible ASCII characters',
    );
  }
  if (
    !Array.isArray(dto.items) ||
    dto.items.length < 1 ||
    dto.items.length > MAX_ORDER_ITEMS
  ) {
    throw new BadRequestException(`Orders require 1–${MAX_ORDER_ITEMS} items`);
  }
  const productIds = new Set<string>();
  for (const item of dto.items) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_ITEM_QUANTITY
    ) {
      throw new BadRequestException('Invalid order item or quantity');
    }
    const productId = item.productId.toLowerCase();
    if (productIds.has(productId)) {
      throw new BadRequestException(
        'Each product may appear only once; use quantity instead',
      );
    }
    productIds.add(productId);
  }
}

/** Fixed field selection and ordering make retries independent of JSON key/item order. */
export function orderFingerprint(dto: CreateOrderDto): string {
  const items = dto.items
    .map((item) => ({
      productId: item.productId.toLowerCase(),
      quantity: item.quantity,
      sizeCode: item.sizeCode ?? null,
      spiceLevel: item.spiceLevel ?? null,
    }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  return createHash('sha256')
    .update(
      JSON.stringify({
        branchId: dto.branchId.toLowerCase(),
        tableSessionId: dto.tableSessionId.toLowerCase(),
        customerName: dto.customerName,
        customerPhone: dto.customerPhone,
        items,
      }),
    )
    .digest('hex');
}

export function calculateOrderTotal(
  items: ReadonlyArray<{ price: number; quantity: number }>,
): number {
  let total = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.price) || item.price < 0) {
      throw new BadRequestException('Invalid product price');
    }
    total += item.price * item.quantity;
    if (!Number.isSafeInteger(total) || total > MAX_SATANG) {
      throw new BadRequestException('Order total exceeds supported amount');
    }
  }
  return total;
}
