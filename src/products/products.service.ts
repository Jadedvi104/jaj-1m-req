import { Injectable } from '@nestjs/common';
import { CrudService } from '../common/crud.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';

@Injectable()
export class ProductsService extends CrudService<
  Product,
  CreateProductDto,
  UpdateProductDto
> {
  protected readonly entityName = 'Product';
  protected build(id: number, dto: CreateProductDto): Product {
    return { id, ...dto };
  }
}
