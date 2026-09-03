import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class ConfirmPaymentDto {
  @IsString() @IsNotEmpty() paymentReference: string;
  @IsString() @IsNotEmpty() transactionId: string;
  @IsInt() @Min(0) amountSatang: number;
}
