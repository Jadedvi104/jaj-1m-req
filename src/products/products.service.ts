import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';
import { ProductsRepository } from './products.repository';

@Injectable()
export class ProductsService {
  constructor(private readonly repository: ProductsRepository) {}

  findAll(): Product[] {
    return this.repository.findAll();
  }

  findOne(id: number): Product {
    return this.requireProduct(this.repository.findById(id), id);
  }

  create(input: CreateProductDto): Product {
    return this.repository.create(input);
  }

  update(id: number, changes: UpdateProductDto): Product {
    return this.requireProduct(this.repository.update(id, changes), id);
  }

  remove(id: number): Product {
    return this.requireProduct(this.repository.remove(id), id);
  }

  private requireProduct(record: Product | null, id: number): Product {
    if (record === null) {
      throw new NotFoundException(`Product ${id} was not found`);
    }
    return record;
  }
}
