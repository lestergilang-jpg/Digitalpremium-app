import type { MigrationContext } from 'migrations/migrator';
import type { MigrationFn } from 'umzug';

export const up: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;

  await queryInterface.sequelize.transaction(async (tx) => {
    await queryInterface.addIndex(
      { tableName: 'voucher', schema },
      ['transaction_id'],
      {
        name: 'voucher_transaction_id_idx',
        using: 'BTREE',
        transaction: tx,
      },
    );

    await queryInterface.addIndex(
      { tableName: 'voucher', schema },
      ['payment_id'],
      {
        name: 'voucher_payment_id_idx',
        using: 'BTREE',
        transaction: tx,
      },
    );

    await queryInterface.addIndex(
      { tableName: 'voucher', schema },
      ['payment_status'],
      {
        name: 'voucher_payment_status_idx',
        using: 'BTREE',
        transaction: tx,
      },
    );
  });
};

export const down: MigrationFn<MigrationContext> = async ({ context }) => {
  const { queryInterface, schema } = context;

  await queryInterface.sequelize.transaction(async (tx) => {
    await queryInterface.removeIndex(
      { tableName: 'voucher', schema },
      'voucher_transaction_id_idx',
      { transaction: tx },
    );

    await queryInterface.removeIndex(
      { tableName: 'voucher', schema },
      'voucher_payment_id_idx',
      { transaction: tx },
    );

    await queryInterface.removeIndex(
      { tableName: 'voucher', schema },
      'voucher_payment_status_idx',
      { transaction: tx },
    );
  });
};
