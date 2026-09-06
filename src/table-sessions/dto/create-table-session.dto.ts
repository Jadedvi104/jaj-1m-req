import {
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from 'class-validator';

export class CreateTableSessionDto {
  @IsUUID() branchId!: string;
  @IsUUID() tablePublicId!: string;
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(128)
  rotatingCode!: string;
}
