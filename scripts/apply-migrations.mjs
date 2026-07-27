// One-off: apply the SQL migrations directly to Supabase Postgres.
// Run:  node scripts/apply-migrations.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const ref = 'ocrsrhxyhdrvodzbtdnu'
const password = 'btWApHPE6*5M*@L'

// Try the direct connection first, then the Singapore pooler (IPv4) as fallback.
const candidates = [
  { label: 'direct', host: `db.${ref}.supabase.co`, port: 5432, user: 'postgres' },
  {
    label: 'pooler-session (ap-southeast-1)',
    host: 'aws-0-ap-southeast-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${ref}`,
  },
]

const files = ['bit2_schema.sql', 'bit2b_projects.sql']

async function connect(c) {
  const client = new pg.Client({
    host: c.host,
    port: c.port,
    user: c.user,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
  })
  await client.connect()
  return client
}

let client
for (const c of candidates) {
  try {
    process.stdout.write(`Connecting via ${c.label} (${c.host})… `)
    client = await connect(c)
    console.log('connected')
    break
  } catch (e) {
    console.log('failed:', e.message)
  }
}
if (!client) {
  console.error('\nAll connection attempts failed.')
  process.exit(2)
}

try {
  for (const f of files) {
    const sql = readFileSync(new URL(`../db/${f}`, import.meta.url), 'utf8')
    process.stdout.write(`Applying ${f}… `)
    await client.query(sql)
    console.log('ok')
  }
  await client.query("notify pgrst, 'reload schema'") // refresh the API cache
  const { rows } = await client.query(
    "select to_regclass('public.project_members') as members, to_regclass('public.projects') as projects",
  )
  console.log('verify:', rows[0])
  console.log('\nDone.')
} finally {
  await client.end()
}
