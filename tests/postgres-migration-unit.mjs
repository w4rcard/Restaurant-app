import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildMigrationScript,
  loadMigrations,
  parseMigrationTarget,
  runMigrations,
  sanitizePsqlDiagnostics,
} from '../server/postgres-migrate.mjs'

const migrations = await loadMigrations()
assert.equal(migrations.length, 1)
assert.equal(migrations[0].version, 1)
assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/)

const script = buildMigrationScript(migrations)
assert.match(script, /BEGIN;/)
assert.match(script, /pg_advisory_xact_lock/)
assert.match(script, /schema_migrations/)
assert.match(script, /checksum/)
assert.match(script, /COMMIT;/)
assert.match(script, /\\if :migration_1_applied/)
assert.match(script, /\\quit 4/)

const schema = await readFile(new URL('../db/postgres/migrations/0001_restaurant_core.sql', import.meta.url), 'utf8')
assert.match(schema, /restaurant_id text NOT NULL/)
assert.match(schema, /FOREIGN KEY \(restaurant_id, employee_id\)/)
assert.match(schema, /credential_state IN \('active', 'must_change', 'reset_required'\)/)
assert.match(schema, /octet_length\(password_hash\) = 32/)
assert.match(schema, /price numeric NOT NULL/)
assert.match(schema, /unit_price_snapshot numeric NOT NULL/)
assert.match(schema, /CREATE TABLE inventory_movements/)
assert.match(schema, /CREATE TABLE sale_lines/)
const tableNames = new Set([...schema.matchAll(/CREATE TABLE ([a-z_]+)/g)].map(match => match[1]))
for (const match of schema.matchAll(/REFERENCES ([a-z_]+)\s*\(/g)) {
  assert.ok(tableNames.has(match[1]), `foreign-key target ${match[1]} must exist in the schema`)
}
for (const match of schema.matchAll(/CREATE TABLE ([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
  assert.match(match[2], /PRIMARY KEY/, `${match[1]} must have a primary key`)
}

const secretUrl = 'postgresql://unit-user:do%40not-log@127.0.0.1:55432/isolated_test?sslmode=disable&application_name=schema-test'
const target = parseMigrationTarget({ POSTGRES_MIGRATION_DATABASE_URL: secretUrl, PATH: 'test-path' })
assert.equal(target.database, 'isolated_test')
assert.equal(target.childEnv.PGUSER, 'unit-user')
assert.equal(target.childEnv.PGPASSWORD, 'do@not-log')
assert.equal(target.childEnv.PGPORT, '55432')
assert.equal(target.childEnv.PGAPPNAME, 'schema-test')
assert.equal(Object.values(target.childEnv).includes(secretUrl), false)
assert.equal(Object.hasOwn(target.childEnv, 'DB_PATH'), false)
assert.doesNotMatch(sanitizePsqlDiagnostics(`connection postgres://${secretUrl.split('://')[1]} password=hidden`), /do%40not-log|hidden/)
assert.throws(() => parseMigrationTarget({ DATABASE_URL: secretUrl }), /POSTGRES_MIGRATION_DATABASE_URL/)
assert.throws(() => parseMigrationTarget({ POSTGRES_MIGRATION_DATABASE_URL: 'file:///restaurant.db' }), /PostgreSQL/)
assert.throws(() => parseMigrationTarget({ POSTGRES_MIGRATION_DATABASE_URL: 'postgresql://unit@localhost/db?options=unsafe' }), /no admitida/)
await assert.rejects(runMigrations({ env: {} }), /POSTGRES_MIGRATION_DATABASE_URL/)

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'restaurant-pg-runner-'))
try {
  const tempMigrations = path.join(tempRoot, 'migrations')
  await mkdir(tempMigrations)
  await writeFile(path.join(tempMigrations, '0001_first.sql'), 'CREATE TABLE first_row (id text PRIMARY KEY);\n')
  const first = await loadMigrations(tempMigrations)
  await writeFile(path.join(tempMigrations, '0001_first.sql'), 'CREATE TABLE first_row (id text PRIMARY KEY, label text);\n')
  const changed = await loadMigrations(tempMigrations)
  assert.notEqual(changed[0].checksum, first[0].checksum)
  await writeFile(path.join(tempMigrations, '0001_first.sql'), 'BEGIN; CREATE TABLE first_row (id text PRIMARY KEY); COMMIT;\n')
  await assert.rejects(loadMigrations(tempMigrations), /incompatible/)
  await writeFile(path.join(tempMigrations, '0001_first.sql'), 'CREATE INDEX CONCURRENTLY first_idx ON first_row (id);\n')
  await assert.rejects(loadMigrations(tempMigrations), /incompatible/)
  await writeFile(path.join(tempMigrations, '0001_first.sql'), 'CREATE TABLE first_row (id text PRIMARY KEY);\n')
  await writeFile(path.join(tempMigrations, '0003_gap.sql'), 'SELECT 1;\n')
  await assert.rejects(loadMigrations(tempMigrations), /consecutivas/)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

console.log('PostgreSQL migration runner unit checks passed (no database connection made).')
