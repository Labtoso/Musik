import crypto from 'node:crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

export function checkPassword(password, hash, salt) {
  const h = crypto.scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}

export class Auth {
  constructor(db) {
    this.db = db;
  }

  needsSetup() {
    return this.db.prepare('SELECT COUNT(*) n FROM users').get().n === 0;
  }

  createUser(name, password, admin = false) {
    name = String(name || '').trim();
    if (!/^[\p{L}\p{N} _.-]{2,32}$/u.test(name)) throw Object.assign(new Error('invalid_name'), { status: 400 });
    if (String(password || '').length < 4) throw Object.assign(new Error('password_short'), { status: 400 });
    if (this.db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) {
      throw Object.assign(new Error('name_taken'), { status: 409 });
    }
    const { hash, salt } = hashPassword(password);
    const r = this.db
      .prepare('INSERT INTO users (name, pass_hash, salt, admin, created) VALUES (?,?,?,?,?)')
      .run(name, hash, salt, admin ? 1 : 0, Date.now());
    return this.user(Number(r.lastInsertRowid));
  }

  setPassword(userId, password) {
    if (String(password || '').length < 4) throw Object.assign(new Error('password_short'), { status: 400 });
    const { hash, salt } = hashPassword(password);
    this.db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
    this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId);
  }

  user(id) {
    const u = this.db.prepare('SELECT id, name, admin, created FROM users WHERE id = ?').get(id);
    return u ? { id: u.id, name: u.name, admin: !!u.admin, created: u.created } : null;
  }

  users() {
    return this.db
      .prepare('SELECT id, name, admin, created FROM users ORDER BY name')
      .all()
      .map((u) => ({ id: u.id, name: u.name, admin: !!u.admin, created: u.created }));
  }

  login(name, password, client = '') {
    const u = this.db.prepare('SELECT * FROM users WHERE name = ?').get(String(name || '').trim());
    if (!u || !checkPassword(password, u.pass_hash, u.salt)) {
      throw Object.assign(new Error('wrong_login'), { status: 401 });
    }
    return { token: this.issue(u.id, client), user: this.user(u.id) };
  }

  issue(userId, client = '') {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO tokens (token, user_id, created, last_used, client) VALUES (?,?,?,?,?)')
      .run(token, userId, now, now, String(client).slice(0, 60));
    return token;
  }

  verify(token) {
    if (!token || typeof token !== 'string' || token.length !== 64) return null;
    const row = this.db.prepare('SELECT user_id, last_used FROM tokens WHERE token = ?').get(token);
    if (!row) return null;
    const now = Date.now();
    if (now - row.last_used > 60000) this.db.prepare('UPDATE tokens SET last_used = ? WHERE token = ?').run(now, token);
    return this.user(row.user_id);
  }

  logout(token) {
    this.db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
  }

  deleteUser(id) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}
