import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SOFT_STALE_MS = 10_000;
const HARD_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_BACKOFF_MS = 50;

/** Recorded inside the lock so a human can see who is holding it. */
interface LockOwner {
  pid: number;
  host: string;
  startedAt: number;
}

let counter = 0;
/** Unique, and safe as a filename on every platform. */
function newOwnerId(): string {
  counter += 1;
  return `${process.pid}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The lock is a DIRECTORY holding exactly one file, named after its owner.
 *
 * The shape is the whole point. Removing a lock safely needs a *conditional*
 * removal — "delete this only if it is still the one I judged" — and POSIX has
 * exactly one: `rmdir` refuses a directory that is not empty. So a holder is
 * represented by a file inside the directory, and every removal is
 *
 *   unlink(dir/<the owner I judged>)  then  rmdir(dir)
 *
 * which cannot touch a lock that has changed hands: the unlink misses a name
 * that is no longer there, and the rmdir then finds the directory occupied by
 * the new holder and fails.
 *
 * Two earlier designs did not have this property. Judging the lock file and
 * then unlinking the path let a reclaimer delete a live lock created after its
 * judgement. Renaming the file aside and putting it back if it turned out to be
 * live shrank the window but did not close it — measured at 48 writers, three
 * restores failed because a third process had taken the path in between, and
 * each one put two writers inside at once.
 */

/** Identifies the holder, so only the holder can release. */
export type LockToken = string;

/**
 * Creates the lock, or returns false if someone holds it.
 *
 * The directory is assembled complete and then renamed into place, so it is
 * never visible in a half-built state. `rename` onto a non-empty directory
 * fails, which is what makes this create-if-absent.
 */
function create(lockDir: string, owner: LockToken): boolean {
  const staging = `${lockDir}.new.${owner}`;
  // Deliberately unguarded: if we cannot even create a directory here (read-only
  // folder, no permission) the caller must see that rather than spin until the
  // timeout.
  fs.mkdirSync(staging);
  try {
    const body: LockOwner = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
    fs.writeFileSync(path.join(staging, owner), JSON.stringify(body));
    try {
      fs.renameSync(staging, lockDir);
      return true;
    } catch {
      // Held, or — on Windows, which will not replace even an empty directory —
      // a lock that is mid-release. Either way: back off and look again.
      return false;
    }
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* renamed away, or best effort */
    }
  }
}

/** Removes exactly the holder we judged abandoned, and only if it still holds. */
function reclaim(lockDir: string, owner: LockToken): void {
  try {
    fs.unlinkSync(path.join(lockDir, owner));
  } catch {
    return; // it let go, or somebody else reclaimed it first
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {
    /* a new holder moved in while we were removing the old entry */
  }
}

/**
 * The id of the holder if the lock is abandoned, or undefined if it is live.
 *
 * Staleness is judged by AGE, never by whether the contents parse. A lock taken
 * microseconds ago may still be being written; treating that as abandoned lets a
 * second writer steal a live lock.
 */
function staleOwner(lockDir: string): LockToken | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(lockDir);
  } catch (err) {
    if (errno(err) === 'ENOTDIR') {
      sweepLegacyLockFile(lockDir);
    }
    return undefined; // gone, or not ours to interpret
  }
  if (entries.length === 0) {
    // Mid-release, or a crash between the unlink and the rmdir. Removing an
    // EMPTY lock directory can never take one away from a holder, because a
    // holder always has its own file inside it.
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* someone claimed it in the meantime, which is the outcome we wanted */
    }
    return undefined;
  }
  if (entries.length !== 1) {
    return undefined; // not a shape we wrote; leave it alone
  }
  const owner = entries[0];
  const file = path.join(lockDir, owner);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const age = Date.now() - stat.mtimeMs;
  if (age <= SOFT_STALE_MS) {
    return undefined;
  }
  if (age > HARD_STALE_MS) {
    return owner;
  }
  let body: LockOwner;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8')) as LockOwner;
  } catch {
    return owner; // past the soft timeout and still unwritten: died mid-acquire
  }
  if (body.host !== os.hostname()) {
    // A different PID namespace (WSL vs Windows, or a container): its pids mean
    // nothing here, so age is the only signal available.
    return owner;
  }
  try {
    process.kill(body.pid, 0);
    return undefined;
  } catch {
    return owner;
  }
}

/** A `.lock` left behind as a plain file by the pre-directory implementation. */
function sweepLegacyLockFile(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (stat.isFile() && Date.now() - stat.mtimeMs > HARD_STALE_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* gone, or not ours to remove */
  }
}

export function acquire(lockDir: string, timeoutMs = DEFAULT_TIMEOUT_MS): LockToken {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    const owner = newOwnerId();
    if (create(lockDir, owner)) {
      return owner;
    }
    // Checked on every path, including reclamation: a lock that cannot be
    // removed (read-only folder, another user's file, a Windows handle) would
    // otherwise spin here forever instead of failing the way callers expect.
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Local Review: timed out waiting for ${lockDir}`);
    }
    const abandoned = staleOwner(lockDir);
    if (abandoned !== undefined) {
      reclaim(lockDir, abandoned);
    }
    // Escalating, jittered backoff. The critical section is sub-millisecond, so
    // the first retries stay tight; a genuinely long wait backs off to 50ms
    // rather than issuing thousands of syscalls a second. The jitter keeps two
    // waiters from retrying in lockstep.
    const ceiling = Math.min(MAX_BACKOFF_MS, 1 + attempt++ * 2);
    sleepSync(ceiling * (0.5 + Math.random()));
  }
}

/**
 * Releases only a lock we still hold. A slow transaction can be declared stale
 * and taken over legitimately; removing unconditionally would then destroy the
 * new holder's lock and let a third writer in.
 */
export function release(lockDir: string, token: LockToken): boolean {
  let held = true;
  try {
    fs.unlinkSync(path.join(lockDir, token));
  } catch {
    held = false; // reclaimed while we held it
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {
    /* refuses while occupied, which is exactly the protection we want */
  }
  return held;
}

/** Never hold this across an await that can block; the body must stay fast. */
export function withLock<T>(lockDir: string, body: () => T): T {
  const token = acquire(lockDir);
  try {
    return body();
  } finally {
    if (!release(lockDir, token)) {
      // Our lock was reclaimed mid-body, so the work above was unprotected.
      // The caller cannot fix it, but it must not be silent.
      process.emitWarning(`Local Review: lock ${lockDir} was taken over while held`);
    }
  }
}
