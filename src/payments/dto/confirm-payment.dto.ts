import {
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';

export class ConfirmPaymentDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(128)
  paymentReference!: string;
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(128)
  transactionId!: string;
  @IsInt() @Min(0) @Max(2_147_483_647) amountSatang!: number;
}
