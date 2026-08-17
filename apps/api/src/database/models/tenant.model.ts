import { Optional } from 'sequelize';
import {
  AllowNull,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export interface TenantAttributes {
  id: string;
  name: string | null;
  status: 'active' | 'pending' | 'suspended';
  custom_domain: string | null;
  trial_ends_at: Date | null;
  subscription_ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TenantCreationAttributes
  extends Optional<
    TenantAttributes,
    'created_at' | 'updated_at' | 'status' | 'name' | 'trial_ends_at' | 'subscription_ends_at'
  > {}

@Table({ tableName: 'tenant' })
export class Tenant extends Model<TenantAttributes, TenantCreationAttributes> {
  @PrimaryKey
  @AllowNull(false)
  @Column(DataType.STRING)
  declare id: string;

  @AllowNull(true)
  @Column(DataType.STRING)
  declare name: string | null;

  @AllowNull(false)
  @Column({
    type: DataType.ENUM('active', 'pending', 'suspended'),
    defaultValue: 'pending',
  })
  declare status: 'active' | 'pending' | 'suspended';

  @AllowNull(true)
  @Column({
    type: DataType.STRING,
    unique: true,
  })
  declare custom_domain: string | null;

  @AllowNull(true)
  @Column(DataType.DATE)
  declare trial_ends_at: Date | null;

  @AllowNull(true)
  @Column(DataType.DATE)
  declare subscription_ends_at: Date | null;
}
