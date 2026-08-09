import { DataTypes, NOW } from 'sequelize';
import type { MigrationContext } from '../migrator';
import type { MigrationFn } from 'umzug';

export const up: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;

  await queryInterface.createTable(
    { tableName: 'account_session', schema },
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      platform: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      identifier: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      session_data: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: NOW,
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: NOW,
      },
    }
  );

  // Add index on platform and identifier
  await queryInterface.addIndex(
    { tableName: 'account_session', schema },
    ['platform', 'identifier'],
    {
      name: `idx_account_session_platform_identifier_${schema}`,
      unique: true,
    }
  );
};

export const down: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;
  await queryInterface.dropTable({ tableName: 'account_session', schema });
};
