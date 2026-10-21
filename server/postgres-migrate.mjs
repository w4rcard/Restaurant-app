import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const migrationDirectory = path.join(projectRoot, 'db', 'postgres', 'migrations')
const targetEnvName = 'POSTGRES_MIGRATION_DATABASE_URL'

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export async function loadMigrations(directory = migrationDirectory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const relevant = entries.filter(entry => entry.name.endsWith('.sql'))
  if (relevant.some(entry => !entry.isFile())) throw new Error('Cada migración .sql debe ser un archivo regular, no un enlace ni directorio.')
  const names = relevant.map(entry => entry.name).sort()
  const migrations = []
  for (const name of names) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(name)
    if (!match) throw new Error(`Nombre de migración no válido: ${name}`)
    const filePath = path.join(directory, name)
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error(`No se aceptan enlaces simbólicos en migraciones: ${name}`)
    const sql = await readFile(filePath, 'utf8')
    if (!sql.trim() || /^\s*\\/m.test(sql)) throw new Error(`La migración ${name} está vacía o contiene comandos psql.`)
    const executableSql = sql.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\r\n]*/g, '').replace(/\/(\*)[\s\S]*?\*(\/)/g, '')
    if (/(?:^|;)\s*(?:BEGIN(?:\s+TRANSACTION)?|START\s+TRANSACTION|COMMIT|ROLLBACK|ABORT)\b/im.test(executableSql)
      || /\b(?:VACUUM|ALTER\s+SYSTEM)\b|\b(?:CREATE|DROP)\s+DATABASE\b|\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(executableSql)) {
      throw new Error(`La migración ${name} contiene una operación incompatible con la transacción única del runner.`)
    }
    migrations.push({ version: Number(match[1]), name, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  if (!migrations.length) throw new Error('No hay migraciones PostgreSQL disponibles.')
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error('Las versiones de migración deben ser consecutivas y comenzar en 0001.')
  })
  return migrations
}

export function parseMigrationTarget(env = process.env) {
  const raw = env[targetEnvName]
  if (!raw) throw new Error(`Falta ${targetEnvName}; no se usará DATABASE_URL ni otro destino implícito.`)
  let url
  try { url = new URL(raw) } catch { throw new Error(`${targetEnvName} no es una URL PostgreSQL válida.`) }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error(`${targetEnvName} debe indicar host y base de datos PostgreSQL.`)
  }
  const allowedOptions = new Set(['sslmode', 'application_name', 'connect_timeout'])
  for (const key of url.searchParams.keys()) {
    if (!allowedOptions.has(key)) throw new Error(`Opción de conexión PostgreSQL no admitida: ${key}`)
  }
  let database
  let username
  let password
  try {
    database = decodeURIComponent(url.pathname.slice(1))
    username = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    throw new Error(`${targetEnvName} contiene codificación URL inválida.`)
  }
  if (!database || !username) throw new Error(`${targetEnvName} debe indicar usuario y nombre de base de datos.`)
  const inheritedEnv = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA']) {
    const value = env[key] ?? process.env[key]
    if (value) inheritedEnv[key] = value
  }
  const passFile = env.PGPASSFILE ?? process.env.PGPASSFILE
  if (passFile) inheritedEnv.PGPASSFILE = passFile
  const childEnv = { ...inheritedEnv,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: username,
  }
  if (password) childEnv.PGPASSWORD = password
  const envNames = { sslmode: 'PGSSLMODE', application_name: 'PGAPPNAME', connect_timeout: 'PGCONNECT_TIMEOUT' }
  for (const key of allowedOptions) {
    const value = url.searchParams.get(key)
    if (value !== null) childEnv[envNames[key]] = value
  }
  return { database, childEnv }
}

export function buildMigrationScript(migrations) {
  const versions = migrations.map(migration => migration.version)
  if (versions.some((version, index) => version !== index + 1)) throw new Error('Las versiones de migración deben ser consecutivas y comenzar en 0001.')
  const expectedVersions = `ARRAY[${versions.join(',')}]::integer[]`
  const lines = [
    '\\set QUIET 1',
    'BEGIN;',
    'SELECT pg_advisory_xact_lock(19467231, 1);',
    'SET LOCAL search_path TO public;',
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL UNIQUE,
      checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    );`,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM public.schema_migrations WHERE NOT (version = ANY(${expectedVersions}))) THEN 'true' ELSE 'false' END AS unknown_state \\gset`,
    '\\if :unknown_state',
    "\\echo ERROR: la base contiene versiones de migración desconocidas.",
    '\\quit 3',
    '\\endif',
    `SELECT CASE WHEN EXISTS (
      SELECT 1 FROM generate_series(1, ${versions.length}) AS expected(version)
      WHERE NOT EXISTS (SELECT 1 FROM public.schema_migrations AS applied WHERE applied.version = expected.version)
        AND EXISTS (SELECT 1 FROM public.schema_migrations WHERE version > expected.version)
    ) THEN 'true' ELSE 'false' END AS migration_gap \\gset`,
    '\\if :migration_gap',
    "\\echo ERROR: el historial de migración tiene versiones faltantes.",
    '\\quit 3',
    '\\endif',
  ]

  for (const migration of migrations) {
    const prefix = `migration_${migration.version}`
    lines.push(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = ${migration.version}) THEN 'true' ELSE 'false' END AS applied \\gset ${prefix}_`,
      `\\if :${prefix}_applied`,
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = ${migration.version} AND name = ${quoteLiteral(migration.name)} AND checksum = ${quoteLiteral(migration.checksum)}) THEN 'true' ELSE 'false' END AS matches \\gset ${prefix}_`,
      `\\if :${prefix}_matches`,
      `\\echo Migración ${migration.version} ya aplicada; checksum verificado.`,
      '\\else',
      `\\echo ERROR: cambió el nombre o checksum de la migración ${migration.version}.`,
      '\\quit 4',
      '\\endif',
      '\\else',
      migration.sql,
      `INSERT INTO public.schema_migrations (version, name, checksum) VALUES (${migration.version}, ${quoteLiteral(migration.name)}, ${quoteLiteral(migration.checksum)});`,
      `\\echo Migración ${migration.version} aplicada.`,
      '\\endif',
    )
  }
  lines.push('COMMIT;')
  return `${lines.join('\n')}\n`
}

export function sanitizePsqlDiagnostics(value) {
  return String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s/]+/gi, 'postgresql://[redacted]')
    .replace(/\b(password|passwd|pwd|PGPASSWORD)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-5)
    .join('\n')
}

export async function runMigrations({ env = process.env, executable = 'psql', directory = migrationDirectory } = {}) {
  const { database, childEnv } = parseMigrationTarget(env)
  const migrations = await loadMigrations(directory)
  const script = buildMigrationScript(migrations)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(executable, ['--no-psqlrc', '--quiet', '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1'], {
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let spawnError
    child.once('error', error => { spawnError = error })
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('close', code => {
      if (spawnError) {
        reject(new Error('No se pudo iniciar psql. Instala el cliente PostgreSQL y vuelve a ejecutar la migración.'))
      } else if (code !== 0) {
        const detail = sanitizePsqlDiagnostics(stderr || stdout)
        reject(new Error(`psql terminó con código ${code ?? 'desconocido'}; la transacción de migración se revirtió.${detail ? `\n${detail}` : ' Revisa el destino y sus permisos.'}`))
      } else {
        resolve({ database, migrationCount: migrations.length })
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(script)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMigrations()
    console.log(`Migraciones PostgreSQL verificadas para la base "${result.database}" (${result.migrationCount} archivo(s)).`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'No se pudieron ejecutar las migraciones PostgreSQL.')
    process.exitCode = 1
  }
}
