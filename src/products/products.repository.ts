import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';

/** Missing records return null; storage failures propagate to the caller. */
export abstract class ProductsRepository {
  abstract findAll(): Product[];
  abstract findById(id: number): Product | null;
  abstract create(input: CreateProductDto): Product;
  abstract update(id: number, changes: UpdateProductDto): Product | null;
  abstract remove(id: number): Product | null;
}
