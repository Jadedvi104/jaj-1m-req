import { Product } from './entities/product.entity';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}
  @Post() create(@Body() dto: CreateProductDto): Product {
    return this.productsService.create(dto);
  }
  @Get() findAll(): Product[] {
    return this.productsService.findAll();
  }
  @Get(':id') findOne(@Param('id', ParseIntPipe) id: number): Product {
    return this.productsService.findOne(id);
  }
  @Patch(':id') update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
  ): Product {
    return this.productsService.update(id, dto);
  }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number): Product {
    return this.productsService.remove(id);
  }
}
