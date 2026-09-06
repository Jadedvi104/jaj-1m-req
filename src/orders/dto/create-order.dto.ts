import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  ValidateIf,
  Matches,
  Max,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_ITEM_QUANTITY, MAX_ORDER_ITEMS } from '../order-policy';

export class CreateOrderItemDto {
  @IsUUID() productId!: string;
  @IsInt() @Min(1) @Max(MAX_ITEM_QUANTITY) quantity!: number;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @MaxLength(30)
  sizeCode?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @MaxLength(30)
  spiceLevel?: string;
}

export class CreateOrderDto {
  @IsUUID() branchId!: string;
  @IsUUID() tableSessionId!: string;
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(100)
  customerName!: string;
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(30)
  customerPhone!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];
}
