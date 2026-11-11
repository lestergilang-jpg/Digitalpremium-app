import { IsEmail, IsNotEmpty, IsOptional, IsPhoneNumber, IsString } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  product_variant_id: string;

  @IsString()
  @IsNotEmpty()
  buyer_name: string;

  @IsEmail({}, { message: 'mohon isi email dengan benar' })
  @IsNotEmpty()
  buyer_email: string;

  @IsString()
  @IsNotEmpty()
  buyer_whatsapp: string;

  @IsString()
  @IsOptional()
  promo_code?: string;

  @IsOptional()
  duration_multiplier?: number;

  @IsOptional()
  quantity?: number;
}
