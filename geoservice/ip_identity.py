"""One server-derived IP = one profile. No browser-cookie authentication."""
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import json
import sqlite3
import uuid


def merge_plan(rows, decrypt):
    """Keep the oldest named profile, not the newest anonymous browser row.

    Privileges/name/organization stay together on the selected profile. Blocked
    status wins over active. Original rows are archived before deletion.
    """
    groups = defaultdict(list)
    for row in rows:
        for field in ('user_name', 'organization_name'):
            value = row.get(field) or ''
            if value and decrypt(value) == '[зашифровано]':
                raise RuntimeError('Cannot decrypt profiles: restore the existing encryption key before merging IP identities')
        groups[str(row['ip']).strip()].append(dict(row))
    plan = []
    for ip, group in sorted(groups.items()):
        def rank(row):
            name = (decrypt(row.get('user_name') or '') or '').strip()
            org = (decrypt(row.get('organization_name') or '') or '').strip()
            return (0 if name else 1 if org else 2, int(row['id']))
        ordered = sorted(group, key=rank)
        primary = ordered[0]
        severity = {'active': 0, 'pending': 1, 'deleted': 2, 'frozen': 3, 'banned': 4}
        status = max(group, key=lambda r: severity.get(r.get('status') or 'active', 5)).get('status') or 'active'
        first = [r.get('first_seen') for r in group if r.get('first_seen')]
        last = [r.get('last_seen') for r in group if r.get('last_seen')]
        plan.append({'ip': ip, 'primary': primary, 'duplicates': ordered[1:],
                     'status': status, 'first_seen': min(first) if first else None,
                     'last_seen': max(last) if last else None})
    return plan


def legacy_profiles(sqlite_path, decrypt):
    """Read old SQLite profile names by IP, never by coincidental numeric ID."""
    path = Path(sqlite_path)
    if not path.exists():
        return {}
    conn = sqlite3.connect(str(path), timeout=60)
    conn.row_factory = sqlite3.Row
    try:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
            return {}
        columns = {row[1] for row in conn.execute('PRAGMA table_info(users)')}
        if not {'ip', 'user_name'}.issubset(columns):
            return {}
        out = {}
        query = 'SELECT * FROM users' + (' ORDER BY id' if 'id' in columns else '')
        for row in conn.execute(query):
            row = dict(row)
            if row.get('status') in ('deleted', 'frozen', 'banned'):
                continue
            name = (decrypt(row.get('user_name') or '') or '').strip()
            if not name or name == '[зашифровано]':
                continue
            ip = str(row.get('ip') or '').strip()
            if ip and ip not in out:
                out[ip] = {'user_name': row['user_name'],
                           'organization_name': row.get('organization_name') or row.get('org_name') or ''}
        return out
    finally:
        conn.close()


def repair_sqlite_tokens(sqlite_path, identities):
    """Repair token ownership by its existing IP; never change key/quota/status."""
    path = Path(sqlite_path)
    if not path.exists():
        return {'updated': 0, 'backup': None}
    conn = sqlite3.connect(str(path), timeout=60)
    try:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tokens'").fetchone():
            return {'updated': 0, 'backup': None}
        pending = []
        for ip, uid in identities.items():
            n = conn.execute('SELECT COUNT(*) FROM tokens WHERE ip=? AND (user_id IS NULL OR user_id!=?)', (ip, uid)).fetchone()[0]
            if n:
                pending.append((uid, ip))
        if not pending:
            return {'updated': 0, 'backup': None}
        directory = path.parent / 'identity_backups'
        directory.mkdir(exist_ok=True)
        backup_path = directory / ('users-before-ip-merge-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8] + '.sqlite')
        backup = sqlite3.connect(str(backup_path))
        try:
            conn.backup(backup)
        finally:
            backup.close()
        changed = 0
        with conn:
            for uid, ip in pending:
                changed += conn.execute('UPDATE tokens SET user_id=? WHERE ip=? AND (user_id IS NULL OR user_id!=?)', (uid, ip, uid)).rowcount
        return {'updated': changed, 'backup': str(backup_path)}
    finally:
        conn.close()


def migrate_ip_identity(engine, decrypt, sqlite_path):
    """Transactional PostgreSQL merge + restart-safe SQLite token repair.

    Fail startup on any migration error. Do not run an IP-only app with a
    partially merged user table. SQLite repair can be retried on next startup.
    """
    from sqlalchemy import inspect, text
    quote = engine.dialect.identifier_preparer.quote
    merged = 0
    legacy = legacy_profiles(sqlite_path, decrypt)
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL lock_timeout = '60s'"))
        conn.execute(text('LOCK TABLE pg_users IN ACCESS EXCLUSIVE MODE'))
        conn.execute(text('''CREATE TABLE IF NOT EXISTS pg_user_ip_merge_archive (
            old_user_id INTEGER PRIMARY KEY,
            canonical_user_id INTEGER NOT NULL,
            ip VARCHAR(45) NOT NULL,
            user_snapshot JSONB NOT NULL,
            merged_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )'''))
        rows = [dict(r) for r in conn.execute(text('SELECT * FROM pg_users ORDER BY id')).mappings()]
        plan = merge_plan(rows, decrypt)
        inspector = inspect(conn)
        refs = set()
        for table in inspector.get_table_names():
            if table in ('pg_users', 'pg_user_ip_merge_archive'):
                continue
            columns = {c['name'] for c in inspector.get_columns(table)}
            # Two legacy relations have no FK constraint; preserve them as well.
            if table in ('pg_login_history', 'pg_pending_requests') and 'user_id' in columns:
                refs.add((table, 'user_id'))
            for fk in inspector.get_foreign_keys(table):
                if fk.get('referred_table') == 'pg_users' and fk.get('referred_columns') == ['id']:
                    if len(fk['constrained_columns']) != 1:
                        raise RuntimeError('Unsupported composite user reference: ' + table)
                    refs.add((table, fk['constrained_columns'][0]))
        for item in plan:
            primary = item['primary']
            legacy_profile = legacy.get(item['ip']) if not (decrypt(primary.get('user_name') or '') or '').strip() else None
            uid = int(primary['id'])
            for old in item['duplicates']:
                conn.execute(text('''INSERT INTO pg_user_ip_merge_archive
                    (old_user_id, canonical_user_id, ip, user_snapshot)
                    VALUES (:old, :new, :ip, CAST(:snapshot AS JSONB))
                    ON CONFLICT (old_user_id) DO NOTHING'''),
                    {'old': old['id'], 'new': uid, 'ip': item['ip'], 'snapshot': json.dumps(old, default=str)})
                for table, column in sorted(refs):
                    conn.execute(text('UPDATE ' + quote(table) + ' SET ' + quote(column) + '=:new WHERE ' + quote(column) + '=:old'), {'new': uid, 'old': old['id']})
                conn.execute(text('DELETE FROM pg_users WHERE id=:old'), {'old': old['id']})
                merged += 1
            if item['duplicates'] or legacy_profile or primary.get('device_id'):
                # Archive the selected profile too, before applying time/status changes.
                conn.execute(text('''INSERT INTO pg_user_ip_merge_archive
                    (old_user_id, canonical_user_id, ip, user_snapshot)
                    VALUES (:old, :new, :ip, CAST(:snapshot AS JSONB))
                    ON CONFLICT (old_user_id) DO NOTHING'''),
                    {'old': uid, 'new': uid, 'ip': item['ip'], 'snapshot': json.dumps(primary, default=str)})
            conn.execute(text('''UPDATE pg_users SET ip=:ip, device_id=NULL,
                status=:status, first_seen=:first, last_seen=:last WHERE id=:uid'''),
                {'ip': item['ip'], 'status': item['status'], 'first': item['first_seen'], 'last': item['last_seen'], 'uid': uid})
            if legacy_profile:
                conn.execute(text('UPDATE pg_users SET user_name=:name, organization_name=:org WHERE id=:uid'),
                             {'name': legacy_profile['user_name'], 'org': primary.get('organization_name') or legacy_profile['organization_name'], 'uid': uid})
        conn.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_users_one_ip_v1 ON pg_users (ip)'))
        identities = {item['ip']: int(item['primary']['id']) for item in plan}
    token_repair = repair_sqlite_tokens(sqlite_path, identities)
    return {'merged_profiles': merged, 'unique_ips': len(identities), 'tokens_repaired': token_repair['updated'], 'sqlite_backup': token_repair['backup']}
