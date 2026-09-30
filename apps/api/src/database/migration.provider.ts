import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';

if (process.env.NODE_ENV !== 'production') {
  try {
    // Ensure tsconfig paths and ts-node are registered for migrations
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('ts-node/register');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('tsconfig-paths/register');
  } catch (e) {
    console.warn('Could not register ts-node or tsconfig-paths', e);
  }
}

@Injectable()
export class MigrationProvider {
  private sequelize: Sequelize;

  constructor(private configService: ConfigService) {
    const databaseUrl = this.configService.get<string>('database.migration_url')
      || this.configService.get<string>('database.url');

    this.sequelize = new Sequelize(databaseUrl!, {
      dialect: 'postgres',
      logging: false,
      define: {
        freezeTableName: true,
      },
    });
  }

  private createUmzug(schema: string, folder: 'master' | 'tenant') {
    // Migrations are located in apps/api/migrations
    // When running from dist, we need to point to the right place.
    // For now, let's assume we can find them relative to the root or via config.
    const migrationsPath = path.join(process.cwd(), 'migrations', folder);
    const globPath = path.join(migrationsPath, '*.{ts,js}').replace(/\\/g, '/');

    return new Umzug({
      migrations: { glob: globPath },
      context: {
        queryInterface: this.sequelize.getQueryInterface(),
        schema,
      },
      storage: new SequelizeStorage({
        sequelize: this.sequelize,
        modelName: `SequelizeMeta_${schema}`,
        schema,
      }),
      logger: console,
    });
  }

  async migrateTenant(schema: string) {
    const umzug = this.createUmzug(schema, 'tenant');
    await umzug.up();
  }

  async createSchema(schema: string) {
    if (!/^[\w-]+$/.test(schema)) {
      throw new Error('Invalid schema name');
    }
    await this.sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }
}
