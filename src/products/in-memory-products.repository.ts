import { Injectable } from '@nestjs/common';
import { InMemoryRepository } from '../common/in-memory.repository';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';
import { ProductsRepository } from './products.repository';

/** Process-local adapter for flat records; not durable persistence. */
@Injectable()
export class InMemoryProductsRepository
  extends InMemoryRepository<Product, CreateProductDto, UpdateProductDto>
  implements ProductsRepository
{
  protected build(id: number, input: CreateProductDto): Product {
    return {
      id,
      name: input.name,
      price: input.price,
      description: input.description,
    };
  }

  override update(id: number, changes: UpdateProductDto): Product | null {
    return super.update(id, {
      name: changes.name,
      price: changes.price,
      description: changes.description,
    });
  }
}
