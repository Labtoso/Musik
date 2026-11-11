import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Recommender, seededRandom, similarity, eventWeight } from '../src/recommend.js';

const NOW = Date.UTC(2026, 10, 11, 12);
const DAY = 86400000;

function fixture() {
  const db = openDb(null);
  db.prepare("INSERT INTO users (id, name, pass_hash, salt, admin, created) VALUES (1,'a','x','y',1,0),(2,'b','x','y',0,0)").run();
  const ins = db.prepare(
    'INSERT INTO tracks (id, path, title, artist, album, genre, year, duration, added) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  let id = 1;
  const add = (artist, album, genre, year, n) => {
    for (let i = 0; i < n; i++, id++) ins.run(id, `/m/${id}.mp3`, `${artist} ${i}`, artist, album, genre, year, 200, NOW - 100 * DAY);
  };
  add('Rocker', 'Loud', 'Rock', 1995, 6); // 1-6
  add('Stoner', 'Heavy', 'Rock; Metal', 1998, 6); // 7-12
  add('Popstar', 'Shiny', 'Pop', 2020, 6); // 13-18
  add('Jazzman', 'Smooth', 'Jazz', 1960, 6); // 19-24
  add('Indie', 'Garage', 'Rock', 2005, 6); // 25-30
  return db;
}

const play = (db, user, track, ts, kind = 'complete', played = 200) =>
  db.prepare('INSERT INTO plays (user_id, track_id, ts, played, duration, kind) VALUES (?,?,?,?,?,?)').run(user, track, ts, played, 200, kind);

test('event weights', () => {
  assert.equal(eventWeight({ kind: 'complete' }), 1);
  assert.equal(eventWeight({ kind: 'skip', played: 5, duration: 200 }), -1);
  assert.equal(eventWeight({ kind: 'skip', played: 150, duration: 200 }), -0.3);
  assert.equal(eventWeight({ kind: 'partial', played: 100, duration: 200 }), 0.5);
});

test('similarity prefers same artist, then genre', () => {
  const a = { artist: 'X', album: 'A', genre: 'Rock', year: 2000 };
  assert.ok(similarity(a, { artist: 'X', album: 'A', genre: 'Rock', year: 2000 }) > similarity(a, { artist: 'Y', genre: 'Rock', year: 2000 }));
  assert.ok(similarity(a, { artist: 'Y', genre: 'Rock' }) > similarity(a, { artist: 'Y', genre: 'Jazz' }));
});

test('mix follows taste: rock fan gets rock, skipped artist sinks', () => {
  const db = fixture();
  for (let i = 1; i <= 4; i++) play(db, 1, i, NOW - 5 * DAY + i * 60000);
  db.prepare('INSERT INTO likes (user_id, track_id, created) VALUES (1, 8, 0)').run();
  for (let i = 19; i <= 22; i++) play(db, 1, i, NOW - 4 * DAY + i * 60000, 'skip', 5);
  const rec = new Recommender(db, { random: seededRandom(7), now: () => NOW });
  const mix = rec.mix(1, 12);
  assert.equal(mix.length, 12);
  const rockIds = new Set([...Array(12)].map((_, i) => i + 1).concat([25, 26, 27, 28, 29, 30]));
  const jazzInTop = mix.slice(0, 8).filter((m) => m.id >= 19 && m.id <= 24).length;
  const rockInTop = mix.slice(0, 8).filter((m) => rockIds.has(m.id)).length;
  assert.ok(rockInTop >= 5, `rock in top 8: ${rockInTop}`);
  assert.equal(jazzInTop, 0);
  // never the same artist twice in a row
  const artist = (id) => db.prepare('SELECT artist FROM tracks WHERE id = ?').get(id).artist;
  for (let i = 1; i < mix.length; i++) assert.notEqual(artist(mix[i].id), artist(mix[i - 1].id));
});

test('collaborative: songs others play together get recommended', () => {
  const db = fixture();
  // user 2 always plays Popstar 13 after Rocker 1
  for (let d = 0; d < 5; d++) {
    play(db, 2, 1, NOW - (10 + d) * DAY);
    play(db, 2, 13, NOW - (10 + d) * DAY + 200000);
  }
  play(db, 1, 1, NOW - 2 * DAY);
  const rec = new Recommender(db, { random: seededRandom(3), now: () => NOW });
  const radio = rec.radio(1, 1, 10);
  const pos = radio.findIndex((r) => r.id === 13);
  assert.ok(pos >= 0 && pos < 4, `Popstar 13 position ${pos}`);
  assert.equal(radio.find((r) => r.id === 13).reason, 'collab');
});

test('recently played songs are pushed down', () => {
  const db = fixture();
  for (let i = 1; i <= 6; i++) play(db, 1, i, NOW - 60 * DAY);
  play(db, 1, 2, NOW - 10 * 60000);
  const rec = new Recommender(db, { random: seededRandom(5), now: () => NOW });
  const mix = rec.mix(1, 30);
  const rocker = mix.filter((m) => m.id >= 1 && m.id <= 6).map((m) => m.id);
  assert.equal(rocker[rocker.length - 1], 2, `rocker order ${rocker}`);
});

test('cold start uses popularity and still returns everything', () => {
  const db = fixture();
  for (let d = 0; d < 6; d++) play(db, 2, 20, NOW - d * DAY);
  const rec = new Recommender(db, { random: seededRandom(9), now: () => NOW });
  const p = rec.profile(1);
  assert.equal(p.cold, true);
  const mix = rec.mix(1, 30);
  assert.equal(mix.length, 30);
  assert.ok(mix.findIndex((m) => m.id === 20) < 5);
});

test('smart shuffle keeps all ids and spreads artists', () => {
  const db = fixture();
  const rec = new Recommender(db, { random: seededRandom(11), now: () => NOW });
  const ids = [1, 2, 3, 4, 13, 14, 19, 20];
  const out = rec.shuffle(1, ids);
  assert.deepEqual([...out].sort((a, b) => a - b), ids);
  const artist = (id) => db.prepare('SELECT artist FROM tracks WHERE id = ?').get(id).artist;
  let same = 0;
  for (let i = 1; i < out.length; i++) if (artist(out[i]) === artist(out[i - 1])) same++;
  assert.ok(same <= 1, `same-artist neighbours: ${same}`);
});
