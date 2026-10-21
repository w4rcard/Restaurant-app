import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  parseMigrationTarget,
  runMigrations,
} from '../server/postgres-migrate.mjs'

const testUrl = process.env.POSTGRES_INTEGRATION_TEST_URL
if (!testUrl) {
  throw new Error('Define POSTGRES_INTEGRATION_TEST_URL para una instancia PostgreSQL desechable de pruebas.')
}

const parsedAdmin = new URL(testUrl)
const adminDatabase = decodeURIComponent(parsedAdmin.pathname.slice(1))
if (!['postgres:', 'postgresql:'].includes(parsedAdmin.protocol)
  || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedAdmin.hostname)
  || !/(^|[_-])test([_-]|$)/i.test(adminDatabase)) {
  throw new Error('La integración exige una base cuyo nombre identifique pruebas y un servidor PostgreSQL local.')
}

const pgAdminEnv = parseMigrationTarget({ POSTGRES_MIGRATION_DATABASE_URL: testUrl }).childEnv
const runnerPath = fileURLToPath(new URL('../server/postgres-migrate.mjs', import.meta.url))
let databaseSequence = 0

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

function psql(database, sql, { expectFailure = false } = {}) {
  const env = { ...pgAdminEnv, PGDATABASE: database }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.env.PSQL_PATH || 'psql', [
      '--no-psqlrc', '--quiet', '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1',
    ], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => reject(error))
    child.once('close', code => {
      if (expectFailure) {
        if (code === 0) reject(new Error('La sentencia PostgreSQL inválida fue aceptada.'))
        else resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      } else if (code !== 0) {
        reject(new Error(`psql falló (${code ?? 'desconocido'}): ${stderr.trim().split(/\r?\n/).slice(-3).join('\n')}`))
      } else resolve(stdout.trim())
    })
    child.stdin.on('error', () => {})
    child.stdin.end(sql)
  })
}

function startPsqlSession(database) {
  const child = spawn(process.env.PSQL_PATH || 'psql', [
    '--no-psqlrc', '--quiet', '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1',
  ], { env: { ...pgAdminEnv, PGDATABASE: database }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => {})
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`psql lock session failed (${code ?? 'unknown'}): ${stderr.trim()}`)))
  })
  return { child, done }
}

function urlFor(database) {
  const url = new URL(testUrl)
  url.pathname = `/${encodeURIComponent(database)}`
  return url.toString()
}

async function createDatabase() {
  const name = `pos_p2a_test_${process.pid}_${++databaseSequence}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  await psql(adminDatabase, `CREATE DATABASE ${quoteIdentifier(name)};`)
  return name
}

async function dropDatabase(name) {
  await psql(adminDatabase, `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE);`)
}

async function withDatabase(callback) {
  const name = await createDatabase()
  try { return await callback(name) } finally { await dropDatabase(name) }
}

function runRunner(database, { directory } = {}) {
  return runMigrations({
    env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: urlFor(database) },
    ...(directory ? { directory } : {}),
  })
}

async function runRunnerProcess(database) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: urlFor(database) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

assert.match(await psql(adminDatabase, 'SHOW server_version_num;'), /^18\d{3,}$/,
  'CI target must be PostgreSQL 18')

await withDatabase(async database => {
  const first = await runRunner(database)
  assert.equal(first.migrationCount, 1)
  const before = await psql(database, 'SELECT version || \'|\' || name || \'|\' || checksum FROM public.schema_migrations ORDER BY version;')
  const rerun = await runRunner(database)
  assert.equal(rerun.migrationCount, 1)
  assert.equal(await psql(database, 'SELECT version || \'|\' || name || \'|\' || checksum FROM public.schema_migrations ORDER BY version;'), before,
    'rerunning must preserve migration version and checksum')

  await psql(database, "INSERT INTO public.schema_migrations(version,name,checksum) VALUES (9,'0099_unknown','" + '0'.repeat(64) + "');")
  await assert.rejects(runRunner(database), /unknown schema migration version/i)
  assert.equal(await psql(database, 'SELECT count(*) FROM public.schema_migrations;'), '2',
    'unknown history must not alter previously recorded migration rows')
})

await withDatabase(async database => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const os = await import('node:os')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pos-pg-history-gap-'))
  try {
    const migrationDir = path.join(temp, 'migrations')
    await mkdir(migrationDir)
    await writeFile(path.join(migrationDir, '0001_first.sql'), 'CREATE TABLE first_probe (id text PRIMARY KEY);\n')
    await writeFile(path.join(migrationDir, '0002_second.sql'), 'CREATE TABLE second_probe (id text PRIMARY KEY);\n')
    await psql(database, `CREATE TABLE public.schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0), name text NOT NULL UNIQUE,
      checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT now()
    ); INSERT INTO public.schema_migrations(version,name,checksum) VALUES (2,'0002_second.sql','${'0'.repeat(64)}');`)
    await assert.rejects(runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: urlFor(database) }, directory: migrationDir }), /incomplete migration history/i)
    assert.equal(await psql(database, 'SELECT count(*) FROM public.schema_migrations;'), '1')
    assert.equal(await psql(database, "SELECT to_regclass('public.first_probe') IS NULL;"), 't')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

await withDatabase(async database => {
  const migrations = await import('../server/postgres-migrate.mjs')
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const os = await import('node:os')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pos-pg-modified-'))
  try {
    await mkdir(path.join(temp, 'migrations'))
    const migrationDir = path.join(temp, 'migrations')
    await writeFile(path.join(migrationDir, '0001_first.sql'), 'CREATE TABLE checksum_probe (id text PRIMARY KEY);\n')
    await migrations.runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: urlFor(database) }, directory: migrationDir })
    await writeFile(path.join(migrationDir, '0001_first.sql'), 'CREATE TABLE checksum_probe (id text PRIMARY KEY, note text);\n')
    await assert.rejects(migrations.runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: urlFor(database) }, directory: migrationDir }), /migration name\/checksum mismatch/i)
    assert.equal(await psql(database, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='checksum_probe';"), '1',
      'checksum mismatch must not alter the applied schema')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

await withDatabase(async database => {
  const migrations = await import('../server/postgres-migrate.mjs')
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const os = await import('node:os')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pos-pg-rollback-'))
  try {
    const migrationDir = path.join(temp, 'migrations')
    await mkdir(migrationDir)
    await writeFile(path.join(migrationDir, '0001_fail.sql'), 'CREATE TABLE rollback_probe (id text PRIMARY KEY);\nSELECT 1 / 0;\n')
    await assert.rejects(migrations.runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: urlFor(database) }, directory: migrationDir }))
    assert.equal(await psql(database, "SELECT count(*) FROM pg_class WHERE relname = 'rollback_probe';"), '0')
    assert.equal(await psql(database, 'SELECT to_regclass(\'public.schema_migrations\') IS NULL;'), 't')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

await withDatabase(async database => {
  const blocker = startPsqlSession(database)
  let released = false
  let runnerProcesses = []
  try {
    blocker.child.stdin.write('SELECT pg_advisory_lock(19467231, 1);\n')
    const waitForLocks = async (predicate, expected = 1) => {
      const end = Date.now() + 8000
      while (Date.now() < end) {
        if (Number(await psql(database, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=19467231::oid AND objid=1::oid AND objsubid=2 AND ${predicate};`)) >= expected) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
    }
    assert.equal(await waitForLocks('granted'), true, 'lock holder must acquire the migration advisory lock')
    runnerProcesses = [runRunnerProcess(database), runRunnerProcess(database)]
    assert.equal(await waitForLocks('NOT granted', 2), true, 'both competing runner sessions must wait on the held lock')
    const waiting = await psql(database, "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=19467231::oid AND objid=1::oid AND objsubid=2 AND NOT granted;")
    assert.equal(waiting, '2', 'two independent psql runner processes must be queued concurrently')
    blocker.child.stdin.end('SELECT pg_advisory_unlock(19467231, 1);\n\\q\n')
    released = true
    await blocker.done
    const results = await Promise.all(runnerProcesses)
    assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.stderr).join('\n'))
  } finally {
    if (!released) {
      blocker.child.stdin.end('SELECT pg_advisory_unlock(19467231, 1);\n\\q\n')
      await blocker.done.catch(() => {})
      await Promise.allSettled(runnerProcesses)
    }
  }
  assert.equal(await psql(database, 'SELECT count(*) FROM public.schema_migrations;'), '1')
  assert.equal(await psql(database, "SELECT count(*) FROM pg_class WHERE relname = 'restaurants';"), '1')
})

await withDatabase(async database => {
  await runRunner(database)
  const setup = `
    INSERT INTO restaurants(id,name,currency_code) VALUES ('legacy:restaurant','Legacy','COP'), ('2002','Second','USD');
    INSERT INTO employees(restaurant_id,id,name,role) VALUES ('legacy:restaurant','17','A','Administrador'), ('2002','emp_2','B','Cocina');
    INSERT INTO employee_credentials(restaurant_id,employee_id,scheme,salt,password_hash,credential_state)
      VALUES ('legacy:restaurant','17','scrypt-v1',decode(repeat('ab',16),'hex'),decode(repeat('cd',32),'hex'),'active');
    INSERT INTO categories(restaurant_id,id,name) VALUES ('legacy:restaurant','cat:1','Bebidas'), ('2002','cat:1','Bebidas'), ('2002','only-second','Solo segundo');
    INSERT INTO products(restaurant_id,id,category_id,name,price,estimated_prep_seconds)
      VALUES ('legacy:restaurant','01','cat:1','Agua',123456789.123456789,0), ('2002','01','cat:1','Agua',0.000000001,0);
  `
  await psql(database, setup)
  assert.equal(await psql(database, "SELECT price::text FROM products WHERE restaurant_id='legacy:restaurant' AND id='01';"), '123456789.123456789')
  assert.equal(await psql(database, "SELECT price::text FROM products WHERE restaurant_id='2002' AND id='01';"), '0.000000001')
  await psql(database, `INSERT INTO sales(restaurant_id,id,currency_code,subtotal,discount,net_total,tip,total,payment_method,people,order_type,created_at)
    VALUES ('legacy:restaurant','sale:1','COP',123456789.123456789,0.000000001,123456789.123456788,0.01,123456789.133456788,'efectivo',1,'pickup',now());`)
  assert.equal(await psql(database, "SELECT subtotal::text || '|' || discount::text || '|' || net_total::text || '|' || tip::text || '|' || total::text FROM sales WHERE restaurant_id='legacy:restaurant' AND id='sale:1';"),
    '123456789.123456789|0.000000001|123456789.123456788|0.01|123456789.133456788')
  await psql(database, "INSERT INTO products(restaurant_id,id,category_id,name,price,estimated_prep_seconds) VALUES ('legacy:restaurant','cross','only-second','Invalid',1,0);", { expectFailure: true })
  await psql(database, "INSERT INTO products(restaurant_id,id,category_id,name,price,estimated_prep_seconds) VALUES ('legacy:restaurant','cross','cat:1','Invalid',-1,0);", { expectFailure: true })
  await psql(database, "INSERT INTO employees(restaurant_id,id,name,role) VALUES ('legacy:restaurant','bad','X','Root');", { expectFailure: true })
  await psql(database, "INSERT INTO categories(restaurant_id,id,name) VALUES ('legacy:restaurant','cat:dup','Bebidas');", { expectFailure: true })
  assert.equal(await psql(database, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('employee_credentials','employee_sessions','restaurants');"), '3')
  assert.equal(await psql(database, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='application_state';"), '0')
  assert.equal(await psql(database, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name IN ('scheme','salt','password_hash','credential_state');"), '0')
})

await withDatabase(async database => {
  const { database: dbName } = await runRunner(database)
  assert.equal(dbName, database)
})

const diagnosticUrl = new URL(testUrl)
diagnosticUrl.port = '1'
await assert.rejects(runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: diagnosticUrl.toString() } }), error => {
  assert.doesNotMatch(error.message, decodeURIComponent(diagnosticUrl.password || 'test_only_password'))
  return /psql termin[oó]|c[oó]digo/i.test(error.message)
})
await assert.rejects(runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: testUrl }, executable: 'pos-p2a-psql-missing' }), /No se pudo iniciar psql/)

const invalidCredentialUrl = new URL(testUrl)
invalidCredentialUrl.password = `${invalidCredentialUrl.password}-invalid`
await assert.rejects(runMigrations({ env: { ...process.env, POSTGRES_MIGRATION_DATABASE_URL: invalidCredentialUrl.toString() } }), error => {
  assert.doesNotMatch(error.message, decodeURIComponent(invalidCredentialUrl.password))
  return /psql termin[oó]|c[oó]digo/i.test(error.message)
})

console.log('PostgreSQL migration integration checks passed on PostgreSQL 18; disposable test databases were dropped.')
