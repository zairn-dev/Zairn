/**
 * In-memory stand-in for the parts of supabase-js the Edge Functions use,
 * shared by the handler tests. RLS visibility of geo_drops is modelled as a
 * set of drop ids the user client may see; the service-role client sees all.
 */

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>

export class FakeDb {
  tables: Record<string, Row[]> = { geo_drops: [], drop_claims: [], drop_location_logs: [], drop_shares: [] }
  visible = new Set<string>()
  rpcCalls: { name: string; args: Row }[] = []
  claimRows: Row[] = [{ claimed: true, claim_id: crypto.randomUUID(), claimed_at: new Date().toISOString() }]
  rateLimitAllowed = true
  /** A fresh user per db, so in-process rate-limit buckets never leak between tests. */
  user = { id: crypto.randomUUID() }
  /** Column defaults Postgres would fill in on insert. */
  defaults: Record<string, Row> = { geo_drops: { status: 'active', claim_count: 0 } }
}

class Query {
  private filters: [string, unknown][] = []
  private orderBy: [string, boolean] | null = null
  private max = Infinity
  private columns: string[] | null = null
  private op: 'select' | 'insert' | 'delete' = 'select'
  private inserted: Row[] = []

  constructor(private db: FakeDb, private table: string, private asUser: boolean) {}

  select(cols?: string) {
    if (cols && cols !== '*') this.columns = cols.split(',').map((c) => c.trim())
    return this
  }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this }
  order(col: string, opts: { ascending: boolean }) { this.orderBy = [col, opts.ascending]; return this }
  limit(n: number) { this.max = n; return this }
  insert(rows: Row | Row[]) {
    this.op = 'insert'
    this.inserted = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      created_at: new Date().toISOString(),
      ...this.db.defaults[this.table],
      ...r,
    }))
    this.db.tables[this.table].push(...this.inserted)
    return this
  }
  delete() { this.op = 'delete'; return this }

  private project(row: Row): Row {
    return this.columns ? Object.fromEntries(this.columns.map((c) => [c, row[c]])) : row
  }
  private matching(): Row[] {
    let rows = this.db.tables[this.table] ?? []
    if (this.asUser && this.table === 'geo_drops') rows = rows.filter((r) => this.db.visible.has(r.id))
    rows = rows.filter((r) => this.filters.every(([c, v]) => r[c] === v))
    if (this.orderBy) {
      const [c, asc] = this.orderBy
      rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1))
    }
    return rows.slice(0, this.max)
  }
  private result(): Row[] {
    return (this.op === 'insert' ? this.inserted : this.matching()).map((r) => this.project(r))
  }

  maybeSingle() { return Promise.resolve({ data: this.result()[0] ?? null, error: null }) }
  single() {
    const r = this.result()
    return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'none' } })
  }
  // deno-lint-ignore no-explicit-any
  then(resolve: any, reject: any) {
    if (this.op === 'delete') {
      const doomed = new Set(this.matching())
      this.db.tables[this.table] = this.db.tables[this.table].filter((r) => !doomed.has(r))
      return Promise.resolve({ data: null, error: null }).then(resolve, reject)
    }
    return Promise.resolve({ data: this.result(), error: null }).then(resolve, reject)
  }
}

export const TEST_USER = { id: crypto.randomUUID() }

/** Handler deps whose createClient returns fakes bound to `db`. */
export function fakeDeps(db: FakeDb, user: { id: string } = TEST_USER) {
  return {
    // deno-lint-ignore no-explicit-any
    createClient: (_url: string, key: string, _opts?: any) => ({
      auth: { getUser: () => Promise.resolve({ data: { user }, error: null }) },
      from: (table: string) => new Query(db, table, key === 'anon'),
      rpc: (name: string, args: Row) => {
        db.rpcCalls.push({ name, args })
        if (name === 'claim_drop') return Promise.resolve({ data: db.claimRows, error: null })
        if (name === 'check_rate_limit') return Promise.resolve({ data: db.rateLimitAllowed, error: null })
        return Promise.resolve({ data: true, error: null })
      },
    }),
  }
}

/** Environment the handlers expect; call once per test module. */
export function setTestEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    SUPABASE_URL: 'http://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SUPABASE_ANON_KEY: 'anon',
    GEODROP_ENCRYPTION_SECRET: 'server-secret',
    CORS_ORIGIN: 'https://app.test',
    ...extra,
  }
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v)
}

export function jsonRequest(path: string, body: Row, origin = 'https://app.test') {
  return new Request(`http://fn.test/${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-jwt', origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
