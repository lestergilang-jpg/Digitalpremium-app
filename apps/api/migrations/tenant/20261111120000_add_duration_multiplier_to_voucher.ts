import type { MigrationContext } from 'migrations/migrator';
import type { MigrationFn } from 'umzug';
import { DataTypes } from 'sequelize';

export const up: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;
  await queryInterface.addColumn(
    { tableName: 'voucher', schema },
    'duration_multiplier',
    {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  );
};

export const down: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;
  await queryInterface.removeColumn(
    { tableName: 'voucher', schema },
    'duration_multiplier',
  );
};

