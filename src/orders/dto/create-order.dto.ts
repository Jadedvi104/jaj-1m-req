import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateOrderItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) quantity: number;
  @IsOptional() @IsString() @MaxLength(30) sizeCode?: string;
  @IsOptional() @IsString() @MaxLength(30) spiceLevel?: string;
}

export class CreateOrderDto {
  @IsUUID() branchId: string;
  @IsUUID() tableSessionId: string;
  @IsString() @IsNotEmpty() @MaxLength(100) customerName: string;
  @IsString() @IsNotEmpty() @MaxLength(30) customerPhone: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
