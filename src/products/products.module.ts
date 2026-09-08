import { InMemoryProductsRepository } from './in-memory-products.repository';
import { ProductsRepository } from './products.repository';
import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [ProductsController],
  providers: [
    ProductsService,
    { provide: ProductsRepository, useClass: InMemoryProductsRepository },
  ],
  exports: [ProductsService],
})
export class ProductsModule {}
