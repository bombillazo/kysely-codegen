import { deepStrictEqual } from 'assert';
import type { Config } from 'cosmiconfig';
import { execa } from 'execa';
import fs from 'fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { join } from 'path';
import { Pool } from 'pg';
import { dedent } from 'ts-dedent';
import packageJson from '../../package.json';
import { RuntimeEnumsStyle } from '../generator';
import { DateParser } from '../introspector/dialects/postgres/date-parser';
import { Cli } from './cli';
import { ConfigError } from './config-error';

const BINARY_PATH = join(process.cwd(), packageJson.bin['kysely-codegen']);
const OUTPUT_PATH = join(__dirname, 'test', 'output.snapshot.ts');

const OUTPUT = dedent`
  /**
   * This file was generated by kysely-codegen.
   * Please do not edit it manually.
   */

  import { ColumnType } from "kysely";

  export enum Status {
    Confirmed = "INVALID",
    Unconfirmed = "UNCONFIRMED",
  }

  export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

  export interface Bacchus {
    bacchusId: Generated<number>;
    status: Status | null;
  }

  export interface DB {
    bacchi: Bacchus;
  }

`;

const down = async (db: Kysely<any>) => {
  await db.schema.dropSchema('cli').cascade().execute();
};

const up = async () => {
  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: 'postgres://user:password@localhost:5433/database',
      }),
    }),
  });

  await db.schema.dropSchema('cli').ifExists().cascade().execute();
  await db.schema.createSchema('cli').execute();
  await db.schema
    .withSchema('cli')
    .createType('status')
    .asEnum(['CONFIRMED', 'UNCONFIRMED'])
    .execute();
  await db.schema
    .createTable('cli.bacchi')
    .addColumn('status', sql`cli.status`)
    .addColumn('bacchus_id', 'serial', (col) => col.primaryKey())
    .execute();

  return db;
};

describe(Cli.name, () => {
  beforeAll(async () => {
    await execa`pnpm build`;
  });

  it('should be able to start the CLI', async () => {
    const output = await execa`node ${BINARY_PATH} --help`.then(
      (r) => r.stdout,
    );
    deepStrictEqual(output.includes('--help, -h'), true);
  });

  it('should be able to run the CLI programmatically with a custom config object', async () => {
    const db = await up();

    const output = await new Cli().run({
      argv: ['--camel-case'],
      config: {
        camelCase: false,
        defaultSchemas: ['cli'],
        dialect: 'postgres',
        includePattern: 'cli.*',
        logLevel: 'silent',
        outFile: null,
        runtimeEnums: RuntimeEnumsStyle.PASCAL_CASE,
        singularize: { '/(bacch)(?:us|i)$/i': '$1us' },
        typeOnlyImports: false,
        url: 'postgres://user:password@localhost:5433/database',
      },
    });

    expect(output).toStrictEqual(
      dedent`
        /**
         * This file was generated by kysely-codegen.
         * Please do not edit it manually.
         */

        import { ColumnType } from "kysely";

        export enum Status {
          Confirmed = "CONFIRMED",
          Unconfirmed = "UNCONFIRMED",
        }

        export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
          ? ColumnType<S, I | undefined, U>
          : ColumnType<T, T | undefined, T>;

        export interface Bacchus {
          bacchusId: Generated<number>;
          status: Status | null;
        }

        export interface DB {
          bacchi: Bacchus;
        }

      `,
    );

    await down(db);
  });

  it('should be able to supply a custom serializer to the config', async () => {
    const db = await up();

    const output = await new Cli().run({
      argv: [
        '--config-file',
        './src/cli/test/config-with-custom-serializer.ts',
      ],
    });

    expect(output).toStrictEqual(
      dedent`
        table bacchi {
          status: status
          bacchus_id: int4
        }

        table foo_bar {
          false: bool
          true: bool
          overridden: text
          id: int4
          date: date
          user_status: status
          user_status_2: status
          array: text
          nullable_pos_int: int4
          defaulted_nullable_pos_int: int4
          defaulted_required_pos_int: int4
          child_domain: int4
          test_domain_is_bool: bool
          timestamps: timestamptz
          interval1: interval
          interval2: interval
          json: json
          json_typed: json
          numeric1: numeric
          numeric2: numeric
          user_name: varchar
        }

        table partitioned_table {
          id: int4
        }
      `,
    );

    await down(db);
  });

  it('should be able to run the CLI successfully using a config file', async () => {
    const db = await up();
    await fs.writeFile(OUTPUT_PATH, OUTPUT);

    expect(async () => {
      await execa`node ${BINARY_PATH} --config-file ./src/cli/test/config.cjs --out-file ${OUTPUT_PATH} --verify`;
    }).not.toThrow();

    await down(db);
  });

  it('should return an exit code of 1 if the generated types are not up-to-date', async () => {
    const db = await up();
    const incorrectOutput = OUTPUT.replace('"CONFIRMED"', '"INVALID"');
    await fs.writeFile(OUTPUT_PATH, incorrectOutput);

    expect(async () => {
      await execa`node ${BINARY_PATH} --config-file ./src/cli/test/config.cjs --out-file ${OUTPUT_PATH} --verify`;
    }).toThrow();

    await down(db);
  });

  it('should parse options correctly', () => {
    const assert = (args: string[], expectedOptions: Partial<Config>) => {
      const cliOptions = new Cli().parseOptions(args, { silent: true });

      deepStrictEqual(cliOptions, {
        url: 'postgres://user:password@localhost:5433/database',
        ...expectedOptions,
      });
    };

    assert(['--camel-case'], { camelCase: true });
    assert(['--date-parser=timestamp'], { dateParser: DateParser.TIMESTAMP });
    assert(['--date-parser=string'], { dateParser: DateParser.STRING });
    assert(['--default-schema=foo'], { defaultSchemas: ['foo'] });
    assert(['--default-schema=foo', '--default-schema=bar'], {
      defaultSchemas: ['foo', 'bar'],
    });
    assert(['--dialect=mysql'], { dialect: 'mysql' });
    assert(['--domains'], { domains: true });
    assert(['--exclude-pattern=public._*'], { excludePattern: 'public._*' });
    assert(['--help'], {});
    assert(['-h'], {});
    assert(['--include-pattern=public._*'], { includePattern: 'public._*' });
    assert(['--log-level=debug'], { logLevel: 'debug' });
    assert(['--no-domains'], { domains: false });
    assert(['--no-type-only-imports'], { typeOnlyImports: false });
    assert(['--out-file=./db.ts'], { outFile: './db.ts' });
    assert(
      [`--overrides={"columns":{"table.override":"{ foo: \\"bar\\" }"}}`],
      { overrides: { columns: { 'table.override': '{ foo: "bar" }' } } },
    );
    assert(['--print'], { print: true });
    assert(['--singularize'], { singularize: true });
    assert(['--type-only-imports'], { typeOnlyImports: true });
    assert(['--type-only-imports=false'], { typeOnlyImports: false });
    assert(['--type-only-imports=true'], { typeOnlyImports: true });
    assert(['--url=postgres://u:p@s/d'], { url: 'postgres://u:p@s/d' });
    assert(['--verify'], { verify: true });
    assert(['--verify=false'], { verify: false });
    assert(['--verify=true'], { verify: true });
  });

  it('should throw an error if a flag is deprecated', () => {
    expect(() => new Cli().parseOptions(['--schema'])).toThrow(
      new RangeError(
        "The flag 'schema' has been deprecated. Use 'default-schema' instead.",
      ),
    );
    expect(() => new Cli().parseOptions(['--singular'])).toThrow(
      new RangeError(
        "The flag 'singular' has been deprecated. Use 'singularize' instead.",
      ),
    );
  });

  it('should throw an error if the config has an invalid schema', () => {
    const assert = (
      config: any,
      message: string,
      path = [Object.keys(config)[0]!],
    ) => {
      expect(() => new Cli().parseOptions([], { config })).toThrow(
        new ConfigError({ message, path }),
      );
    };

    assert({ camelCase: 'true' }, 'Expected boolean, received string');
    assert(
      { dateParser: 'timestamps' },
      "Invalid enum value. Expected 'string' | 'timestamp', received 'timestamps'",
    );
    assert({ defaultSchemas: 'public' }, 'Expected array, received string');
    assert(
      { dialect: 'sqlite3' },
      "Invalid enum value. Expected 'bun-sqlite' | 'kysely-bun-sqlite' | 'libsql' | 'mssql' | 'mysql' | 'postgres' | 'sqlite' | 'worker-bun-sqlite', received 'sqlite3'",
    );
    assert({ domains: 'true' }, 'Expected boolean, received string');
    assert({ envFile: null }, 'Expected string, received null');
    assert({ excludePattern: false }, 'Expected string, received boolean');
    assert({ includePattern: false }, 'Expected string, received boolean');
    assert(
      { logLevel: 0 },
      "Expected 'silent' | 'error' | 'warn' | 'info' | 'debug', received number",
    );
    assert(
      { numericParser: 'numbers' },
      "Invalid enum value. Expected 'number' | 'number-or-string' | 'string', received 'numbers'",
    );
    assert({ outFile: false }, 'Expected string, received boolean');
    assert({ overrides: { columns: [] } }, 'Expected object, received array', [
      'overrides',
      'columns',
    ]);
    assert({ partitions: 'true' }, 'Expected boolean, received string');
    assert({ print: 'true' }, 'Expected boolean, received string');
    assert({ runtimeEnums: 'true' }, 'Invalid input');
    assert({ singularize: 'true' }, 'Invalid input');
    assert({ typeOnlyImports: 'true' }, 'Expected boolean, received string');
    assert({ url: null }, 'Expected string, received null');
    assert({ verify: 'true' }, 'Expected boolean, received string');
  });
});
