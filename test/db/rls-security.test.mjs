// Regression tests for authorization holes found in the 2026-10 audit. Each
// test performs the attack as the attacker's Supabase role and asserts it is
// refused, so a policy or grant regression turns the suite red.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, createUser, as, asAnon, asService } from './harness.mjs';

let db;
before(async () => {
  const built = await freshDb();
  assert.deepEqual(built.failures, [], 'migrations must apply cleanly');
  db = built.db;
});

const RLS = /row-level security|permission denied/;

async function canExecute(role, signature) {
  const { rows } = await db.query('select has_function_privilege($1, $2, $3) as ok', [role, signature, 'execute']);
  return rows[0].ok;
}

async function insertDrop(creator, extra = {}) {
  const cols = { creator_id: creator, lat: 35.68, lon: 139.76, geohash: 'xn76urx', title: 'drop', ...extra };
  const keys = Object.keys(cols);
  const { rows } = await db.query(
    `insert into geo_drops (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(cols),
  );
  return rows[0].id;
}

test('a friend request cannot be created already accepted', async () => {
  const attacker = await createUser(db);
  const victim = await createUser(db);
  await assert.rejects(
    as(db, attacker, (tx) => tx.query(
      "insert into friend_requests (from_user_id, to_user_id, status) values ($1, $2, 'accepted')",
      [attacker, victim])),
    RLS,
  );
  await as(db, attacker, (tx) => tx.query(
    'insert into friend_requests (from_user_id, to_user_id) values ($1, $2)', [attacker, victim]));
});

test('an accepted friendship cannot be deleted directly (it would orphan share rules)', async () => {
  const a = await createUser(db);
  const b = await createUser(db);
  const { rows } = await db.query(
    "insert into friend_requests (from_user_id, to_user_id, status) values ($1, $2, 'accepted') returning id", [a, b]);
  await as(db, a, (tx) => tx.query('delete from friend_requests where id = $1', [rows[0].id]));
  const left = await db.query('select 1 from friend_requests where id = $1', [rows[0].id]);
  assert.equal(left.rows.length, 1);
});

test('ghost mode hides current and historical location from share-rule viewers', async () => {
  const owner = await createUser(db);
  const viewer = await createUser(db);
  await db.query("insert into share_rules (owner_id, viewer_id, level) values ($1, $2, 'history')", [owner, viewer]);
  await db.query('insert into locations_current (user_id, lat, lon) values ($1, 35.68, 139.76)', [owner]);
  await db.query('insert into locations_history (user_id, lat, lon) values ($1, 35.68, 139.76)', [owner]);

  const visible = async () => as(db, viewer, async (tx) => ({
    current: (await tx.query('select 1 from locations_current where user_id = $1', [owner])).rows.length,
    history: (await tx.query('select 1 from locations_history where user_id = $1', [owner])).rows.length,
  }));
  assert.deepEqual(await visible(), { current: 1, history: 1 }, 'precondition: viewer can see before ghosting');

  await as(db, owner, (tx) => tx.query(
    'insert into user_settings (user_id, ghost_mode) values ($1, true) on conflict (user_id) do update set ghost_mode = true',
    [owner]));
  assert.deepEqual(await visible(), { current: 0, history: 0 });
});

test('location history cannot be written while in ghost mode', async () => {
  const owner = await createUser(db);
  await db.query('insert into user_settings (user_id, ghost_mode) values ($1, true)', [owner]);
  await assert.rejects(
    as(db, owner, (tx) => tx.query('insert into locations_history (user_id, lat, lon) values ($1, 1, 1)', [owner])),
    /ghost mode/,
  );
});

test('friends without a history share rule cannot read visited cells', async () => {
  const owner = await createUser(db);
  const friend = await createUser(db);
  await db.query("insert into friend_requests (from_user_id, to_user_id, status) values ($1, $2, 'accepted')", [owner, friend]);
  await db.query("insert into visited_cells (user_id, geohash) values ($1, 'xn76urx')", [owner]);
  const count = async () => as(db, friend, async (tx) =>
    (await tx.query('select 1 from visited_cells where user_id = $1', [owner])).rows.length);

  assert.equal(await count(), 0, 'friendship alone must not expose visited cells');
  await db.query("insert into share_rules (owner_id, viewer_id, level) values ($1, $2, 'history')", [owner, friend]);
  assert.equal(await count(), 1);
  await db.query('insert into user_settings (user_id, ghost_mode) values ($1, true)', [owner]);
  assert.equal(await count(), 0, 'ghost mode must hide visited cells too');
});

test('claim counters can only be changed by the server', async () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await canExecute(role, 'increment_claim_count(uuid)'), false, `${role} increment`);
    assert.equal(await canExecute(role, 'decrement_claim_count(uuid)'), false, `${role} decrement`);
  }
});

test('claim_drop is atomic, enforces max_claims and single claim, and is server-only', async () => {
  const creator = await createUser(db);
  const u1 = await createUser(db);
  const u2 = await createUser(db);
  const drop = await insertDrop(creator, { max_claims: 1 });
  const sig = 'claim_drop(uuid, uuid, double precision, double precision, real, jsonb)';
  for (const role of ['anon', 'authenticated']) assert.equal(await canExecute(role, sig), false, role);

  const claim = (user) => asService(db, (tx) => tx.query(
    "select * from claim_drop($1, $2, 35.68, 139.76, 1.5, '[]'::jsonb)", [drop, user]));
  const first = await claim(u1);
  assert.equal(first.rows[0].claimed, true);
  await assert.rejects(claim(u1), /already claimed/i);
  const second = await claim(u2);
  assert.equal(second.rows[0].claimed, false, 'max_claims reached');
  const { rows } = await db.query('select claim_count from geo_drops where id = $1', [drop]);
  assert.equal(rows[0].claim_count, 1);
});

test('rate-limit and maintenance functions are not callable by clients', async () => {
  const serverOnly = [
    'check_rate_limit(text, integer, integer)',
    'cleanup_stale_rate_limits(integer)',
    'cleanup_expired_search_sessions()',
    'realtime_publication_healthcheck()',
  ];
  for (const sig of serverOnly) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await canExecute(role, sig), false, `${role} ${sig}`);
    }
  }
  for (const sig of ['issue_search_session(integer)', 'consume_search_session(text, text)',
    'is_group_member(uuid, uuid)', 'is_chat_room_member(uuid, uuid)']) {
    assert.equal(await canExecute('anon', sig), false, `anon ${sig}`);
  }
});

test('search session TTL is bounded server-side', async () => {
  const user = await createUser(db);
  const { rows } = await as(db, user, (tx) => tx.query(
    'select extract(epoch from (expires_at - now())) as ttl from issue_search_session(86400 * 365)'));
  assert.ok(Number(rows[0].ttl) <= 600, `ttl ${rows[0].ttl}s`);
});

test('clients cannot forge server-side unlock history', async () => {
  const user = await createUser(db);
  await assert.rejects(
    as(db, user, (tx) => tx.query(
      "insert into drop_location_logs (user_id, lat, lon, geohash, action) values ($1, 1, 1, 's', 'unlock_attempt')", [user])),
    RLS,
  );
  await as(db, user, (tx) => tx.query(
    "insert into drop_location_logs (user_id, lat, lon, geohash, action, created_at) values ($1, 1, 1, 's', 'search', '2000-01-01')",
    [user]));
  const { rows } = await db.query(
    "select created_at > now() - interval '1 minute' as fresh from drop_location_logs where user_id = $1", [user]);
  assert.equal(rows[0].fresh, true, 'client-supplied created_at must be overridden');
});

test('users cannot join chat rooms or move memberships/messages between rooms', async () => {
  const member = await createUser(db);
  const outsider = await createUser(db);
  const room = (await db.query("insert into chat_rooms (type) values ('direct') returning id")).rows[0].id;
  const other = (await db.query("insert into chat_rooms (type) values ('direct') returning id")).rows[0].id;
  await db.query('insert into chat_room_members (room_id, user_id) values ($1, $2), ($3, $2)', [room, member, other]);

  await assert.rejects(
    as(db, outsider, (tx) => tx.query('insert into chat_room_members (room_id, user_id) values ($1, $2)', [room, outsider])),
    RLS,
  );
  const third = (await db.query("insert into chat_rooms (type) values ('direct') returning id")).rows[0].id;
  await assert.rejects(
    as(db, member, (tx) => tx.query(
      'update chat_room_members set room_id = $1 where room_id = $2 and user_id = $3', [third, room, member])),
    RLS,
  );
  await as(db, member, (tx) => tx.query(
    'update chat_room_members set last_read_at = now() where room_id = $1 and user_id = $2', [room, member]));

  const msg = await as(db, member, (tx) => tx.query(
    "insert into messages (room_id, sender_id, content) values ($1, $2, 'hi') returning id", [room, member]));
  await assert.rejects(
    as(db, member, (tx) => tx.query('update messages set room_id = $1 where id = $2', [other, msg.rows[0].id])),
    RLS,
  );
});

test('leaving a group revokes access to its chat', async () => {
  const owner = await createUser(db);
  const member = await createUser(db);
  const group = (await db.query("insert into groups (name, owner_id) values ('g', $1) returning id", [owner])).rows[0].id;
  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member')",
    [group, owner, member]);
  const room = (await db.query("insert into chat_rooms (type, group_id) values ('group', $1) returning id", [group])).rows[0].id;
  await db.query('insert into chat_room_members (room_id, user_id) values ($1, $2), ($1, $3)', [room, owner, member]);
  await db.query("insert into messages (room_id, sender_id, content) values ($1, $2, 'secret plan')", [room, owner]);

  const readable = async () => as(db, member, async (tx) =>
    (await tx.query('select 1 from messages where room_id = $1', [room])).rows.length);
  assert.equal(await readable(), 1, 'precondition: member can read');
  await as(db, member, (tx) => tx.query('select leave_group($1)', [group]));
  assert.equal(await readable(), 0);
});

test('drops can only be created by the server (create-drop)', async () => {
  const user = await createUser(db);
  await assert.rejects(
    as(db, user, (tx) => tx.query(
      "insert into geo_drops (creator_id, lat, lon, geohash, title) values ($1, 1, 1, 's', 'spam')", [user])),
    RLS,
  );
  const { rows } = await asService(db, (tx) => tx.query(
    "insert into geo_drops (creator_id, lat, lon, geohash, title) values ($1, 1, 1, 's', 'ok') returning id", [user]));
  assert.equal(rows.length, 1);
});

test('geo_drops secret columns are not readable by clients', async () => {
  const secret = ['password_hash', 'encryption_salt', 'encrypted_content', 'proof_secret_hashes', 'search_tokens', 'pin_status'];
  for (const role of ['anon', 'authenticated']) {
    for (const col of secret) {
      const { rows } = await db.query('select has_column_privilege($1, $2, $3, $4) as ok', [role, 'geo_drops', col, 'select']);
      assert.equal(rows[0].ok, false, `${role} can select geo_drops.${col}`);
    }
  }
});

test('every SECURITY DEFINER function in public pins search_path', async () => {
  const { rows } = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
     order by 1`);
  assert.deepEqual(rows.map((r) => r.proname), []);
});

test('objects that used to exist only in database/*.sql are created by migrations', async () => {
  const has = async (sql) => (await db.query(sql)).rows.length > 0;
  assert.ok(await has("select 1 from pg_class where relname = 'sharing_policies'"), 'sharing_policies');
  for (const trg of ['trg_enforce_ghost_mode_history', 'trg_rate_limit_messages', 'trg_rate_limit_location']) {
    assert.ok(await has(`select 1 from pg_trigger where tgname = '${trg}'`), trg);
  }
  assert.ok(await has("select 1 from pg_class where relname = 'edge_rate_limits' and relrowsecurity"), 'edge_rate_limits RLS');
  for (const con of ['messages_content_check', 'location_reactions_emoji_check', 'location_reactions_message_check',
    'sharing_policies_coarse_radius']) {
    assert.ok(await has(`select 1 from pg_constraint where conname = '${con}'`), con);
  }
  const join = await db.query("select prosrc from pg_proc where proname = 'join_group_by_invite'");
  assert.match(join.rows[0].prosrc, /Too many join attempts/);
});

test('oversized chat messages are rejected', async () => {
  const a = await createUser(db);
  const room = (await db.query("insert into chat_rooms (type) values ('direct') returning id")).rows[0].id;
  await db.query('insert into chat_room_members (room_id, user_id) values ($1, $2)', [room, a]);
  await assert.rejects(
    as(db, a, (tx) => tx.query('insert into messages (room_id, sender_id, content) values ($1, $2, $3)',
      [room, a, 'x'.repeat(10001)])),
    /messages_content_check/,
  );
});

test('legitimate flows still work: befriend, share, chat, unfriend', async () => {
  const a = await createUser(db);
  const b = await createUser(db);
  const req = await as(db, a, (tx) => tx.query(
    'insert into friend_requests (from_user_id, to_user_id) values ($1, $2) returning id', [a, b]));
  await as(db, b, (tx) => tx.query('select accept_friend_request($1)', [req.rows[0].id]));
  await as(db, a, (tx) => tx.query('insert into locations_current (user_id, lat, lon) values ($1, 35.6, 139.7)', [a]));
  const seen = await as(db, b, async (tx) =>
    (await tx.query('select 1 from locations_current where user_id = $1', [a])).rows.length);
  assert.equal(seen, 1, 'friend sees shared location');

  const room = await as(db, a, async (tx) => (await tx.query('select create_direct_chat($1) as id', [b])).rows[0].id);
  await as(db, a, (tx) => tx.query("insert into messages (room_id, sender_id, content) values ($1, $2, 'hello')", [room, a]));
  const got = await as(db, b, async (tx) =>
    (await tx.query('select content from messages where room_id = $1', [room])).rows);
  assert.deepEqual(got.map((r) => r.content), ['hello']);
  await as(db, b, (tx) => tx.query(
    'update chat_room_members set last_read_at = now() where room_id = $1 and user_id = $2', [room, b]));

  await as(db, a, (tx) => tx.query('select remove_friend($1)', [b]));
  const after = await as(db, b, async (tx) =>
    (await tx.query('select 1 from locations_current where user_id = $1', [a])).rows.length);
  assert.equal(after, 0, 'unfriended viewer loses access');
});

test('geo drop tables are readable without policy recursion; private drops reach only recipients', async () => {
  const creator = await createUser(db);
  const recipient = await createUser(db);
  const stranger = await createUser(db);
  const drop = await insertDrop(creator, { visibility: 'private' });
  await db.query('insert into drop_shares (drop_id, user_id) values ($1, $2)', [drop, recipient]);
  await db.query(
    'insert into drop_claims (drop_id, user_id, lat, lon, distance_meters) values ($1, $2, 35.68, 139.76, 3)', [drop, recipient]);

  const visible = (uid) => as(db, uid, async (tx) => ({
    drop: (await tx.query('select 1 from geo_drops where id = $1', [drop])).rows.length,
    shares: (await tx.query('select 1 from drop_shares where drop_id = $1', [drop])).rows.length,
    claims: (await tx.query('select 1 from drop_claims where drop_id = $1', [drop])).rows.length,
  }));
  assert.deepEqual(await visible(creator), { drop: 1, shares: 1, claims: 1 }, 'creator sees drop, shares and claims');
  assert.deepEqual(await visible(recipient), { drop: 1, shares: 1, claims: 1 }, 'recipient sees the drop');
  assert.deepEqual(await visible(stranger), { drop: 0, shares: 0, claims: 0 }, 'stranger sees nothing');
  await asAnon(db, (tx) => tx.query('select 1 from geo_drops'));

  // The SECURITY DEFINER helpers only answer for the caller.
  const probe = await as(db, stranger, async (tx) => (await tx.query(
    'select is_drop_creator($1, $2) as c, is_drop_shared_with($1, $3) as s', [drop, creator, recipient])).rows[0]);
  assert.deepEqual(probe, { c: false, s: false });
  const { rows } = await db.query("select to_regprocedure('public.is_friend(uuid,uuid)') as f");
  assert.equal(rows[0].f, null, 'is_friend (friendship oracle) must not exist');
});

test('anon gets no rows from location tables', async () => {
  const owner = await createUser(db);
  await db.query('insert into locations_current (user_id, lat, lon) values ($1, 1, 1) on conflict do nothing', [owner]);
  const n = await asAnon(db, async (tx) => (await tx.query('select 1 from locations_current')).rows.length);
  assert.equal(n, 0);
});
