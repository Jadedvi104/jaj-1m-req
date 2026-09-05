import { ValidationPipe } from '@nestjs/common';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { UpdateProductDto } from '../products/dto/update-product.dto';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { CreateTableSessionDto } from '../table-sessions/dto/create-table-session.dto';
import { ConfirmPaymentDto } from '../payments/dto/confirm-payment.dto';

const id = '00000000-0000-4000-8000-000000000001';
const order = {
  branchId: id,
  tableSessionId: id,
  customerName: 'A',
  customerPhone: '080',
  items: [{ productId: id, quantity: 1 }],
};
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

describe('DTO boundary contracts', () => {
  it.each([
    [CreateUserDto, { name: 'a'.repeat(100), email: 'a@example.com' }],
    [UpdateUserDto, {}],
    [UpdateProductDto, {}],
    [
      CreateProductDto,
      { name: 'a'.repeat(200), price: 0, description: 'a'.repeat(2000) },
    ],
    [
      CreateOrderDto,
      {
        ...order,
        customerName: 'a'.repeat(100),
        customerPhone: 'a'.repeat(30),
        items: [
          {
            productId: id,
            quantity: 1,
            sizeCode: 'a'.repeat(30),
            spiceLevel: 'a'.repeat(30),
          },
        ],
      },
    ],
    [
      ConfirmPaymentDto,
      { paymentReference: 'ref', transactionId: 'txn', amountSatang: 0 },
    ],
  ])('accepts allowed boundary for %p', async (metatype, payload) => {
    await expect(
      pipe.transform(payload, { type: 'body', metatype }),
    ).resolves.toMatchObject(payload);
  });
  it.each([
    [CreateUserDto, { name: 'a'.repeat(101), email: 'a@example.com' }],
    [UpdateUserDto, { name: null }],
    [UpdateUserDto, { email: null }],
    [UpdateUserDto, { email: 'bad' }],
    [UpdateUserDto, { admin: true }],
    [UpdateProductDto, { price: null }],
    [UpdateProductDto, { price: -0.01 }],
    [UpdateProductDto, { name: '' }],
    [UpdateProductDto, { description: 123 }],
    [CreateProductDto, { name: 'a'.repeat(201), price: 1 }],
    [CreateProductDto, { name: 'A', price: 1, description: 'a'.repeat(2001) }],
    [CreateOrderDto, { ...order, items: null }],
    [CreateOrderDto, { ...order, items: [null] }],
    [CreateOrderDto, { ...order, customerPhone: 'a'.repeat(31) }],
    [
      CreateOrderDto,
      {
        ...order,
        items: [{ productId: id, quantity: 1, sizeCode: 'a'.repeat(31) }],
      },
    ],
    [
      CreateOrderDto,
      {
        ...order,
        items: [{ productId: id, quantity: 1, spiceLevel: 'a'.repeat(31) }],
      },
    ],
    [
      CreateTableSessionDto,
      { branchId: id, tablePublicId: 'bad', rotatingCode: 'code' },
    ],
    [
      CreateTableSessionDto,
      { branchId: id, tablePublicId: id, rotatingCode: 123 },
    ],
    [
      ConfirmPaymentDto,
      { paymentReference: '', transactionId: 'txn', amountSatang: 1 },
    ],
    [
      ConfirmPaymentDto,
      { paymentReference: 'ref', transactionId: '', amountSatang: 1 },
    ],
  ])('rejects invalid boundary for %p: %p', async (metatype, payload) => {
    await expect(
      pipe.transform(payload, { type: 'body', metatype }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
