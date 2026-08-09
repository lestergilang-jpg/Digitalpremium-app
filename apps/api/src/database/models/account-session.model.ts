import { Optional } from 'sequelize';
import {
  AllowNull,
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export interface AccountSessionAttributes {
  id: string;
  platform: string;
  identifier: string;
  session_data: any;
  created_at: Date;
  updated_at: Date;
}

export interface AccountSessionCreationAttributes extends Optional<
  AccountSessionAttributes,
  'id' | 'created_at' | 'updated_at'
> {}

@Table({ tableName: 'account_session' })
export class AccountSession extends Model<
  AccountSessionAttributes,
  AccountSessionCreationAttributes
> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.BIGINT)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING(50))
  declare platform: string;

  @AllowNull(false)
  @Column(DataType.STRING(255))
  declare identifier: string;

  @AllowNull(false)
  @Column(DataType.JSONB)
  declare session_data: any;
}
