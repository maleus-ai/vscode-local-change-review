const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { acquire, release, withLock } = require(__dirname + '/../out/core/lock.js');
let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${e ? ' — ' + e : ''}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
const lock = path.join(dir, '.lock');

// release only removes a lock we still hold
let token = acquire(lock);
fs.unlinkSync(path.join(lock, token));                       // reclaimed out from under us
fs.writeFileSync(path.join(lock, 'someone-else'), '{}');     // and retaken
check('release refuses a lock taken over by someone else', release(lock, token) === false);
check('and leaves the new holder\'s lock in place', fs.existsSync(path.join(lock, 'someone-else')));
fs.rmSync(lock, { recursive: true, force: true });
token = acquire(lock);
check('release removes a lock we do hold', release(lock, token) === true && !fs.existsSync(lock));
check('a second acquire is refused while the first is held', (() => {
  const held = acquire(lock);
  let blocked = false;
  try { acquire(lock, 150); } catch { blocked = true; }
  release(lock, held);
  return blocked;
})());

// a stale lock in a folder we cannot write to must fail fast, not spin. It now
// surfaces the underlying EACCES immediately rather than after the timeout,
// because the lock file is created by linking a temp file next to it.
const readOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
const stuck = path.join(readOnly, '.lock');
fs.mkdirSync(stuck);
fs.writeFileSync(path.join(stuck, '999999-dead'), JSON.stringify({ pid: 999999, host: 'nowhere', startedAt: 0 }));
fs.utimesSync(path.join(stuck, '999999-dead'), new Date(0), new Date(0));
fs.chmodSync(readOnly, 0o555);
const t0 = Date.now();
try { acquire(stuck, 300); check('unremovable stale lock spins forever', false); }
catch (e) { check('unremovable stale lock fails instead of spinning', Date.now() - t0 < 3000, `${Date.now() - t0}ms, ${e.code || e.message.slice(0, 40)}`); }
fs.chmodSync(readOnly, 0o755); fs.rmSync(readOnly, { recursive: true, force: true });

// mutual exclusion under concurrent stale reclamation
//
// Sized to actually reach the race window. An earlier version used 3 writers
// and a 1ms critical section and passed 6/6 against a reclamation bug that
// 24 writers exposed in seconds — a race test that cannot reach the window is
// worse than no test, because it reads as proof.
const WRITERS = 48;
const ROUNDS = 50;
const journal = path.join(dir, 'journal');
fs.writeFileSync(journal, '');
const t1 = Date.now();
const kids = Array.from({ length: WRITERS }, () =>
  spawn(process.execPath, [path.join(__dirname, 'lock.worker.js'), lock, journal, String(ROUNDS)], { stdio: 'inherit' }));
Promise.all(kids.map((k) => new Promise((r) => k.on('close', r)))).then(() => {
  let inside = null, violations = 0, entries = 0, lost = 0;
  for (const line of fs.readFileSync(journal, 'utf8').trim().split('\n')) {
    const [kind, pid] = line.split(' ');
    if (kind === 'IN') { entries++; if (inside !== null) violations++; inside = pid; }
    else if (kind === 'LOST') { lost++; }
    else if (inside === pid) { inside = null; }
  }
  check(`${WRITERS} writers racing on stale locks never overlap`, violations === 0,
    `${entries} acquisitions, ${violations} overlaps, ${lost} locks lost while held, ${Date.now() - t1}ms`);
  check('no lock is removed while its holder still has it', lost === 0, `${lost} of ${entries}`);
  const left = fs.readdirSync(dir).filter((f) => f !== 'journal');
  check('no temp files left behind', left.length === 0, left.join(', '));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
