import type { MigrationContext } from 'migrations/migrator';
import type { MigrationFn } from 'umzug';
import { DataTypes } from 'sequelize';

export const up: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;

  await queryInterface.addColumn({ tableName: 'tenant', schema }, 'trial_ends_at', {
    type: DataTypes.DATE,
    allowNull: true,
  });

  await queryInterface.addColumn({ tableName: 'tenant', schema }, 'subscription_ends_at', {
    type: DataTypes.DATE,
    allowNull: true,
  });
};

export const down: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;

  await queryInterface.removeColumn({ tableName: 'tenant', schema }, 'trial_ends_at');
  await queryInterface.removeColumn({ tableName: 'tenant', schema }, 'subscription_ends_at');
};
