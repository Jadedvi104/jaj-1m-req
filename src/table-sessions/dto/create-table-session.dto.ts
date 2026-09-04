import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateTableSessionDto {
  @IsUUID() branchId: string;
  @IsUUID() tablePublicId: string;
  @IsString() @IsNotEmpty() rotatingCode: string;
}
