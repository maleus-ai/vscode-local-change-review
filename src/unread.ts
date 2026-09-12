import * as vscode from 'vscode';

import type { ReviewThreadData } from './core/types';

const STATE_KEY = 'localReview.lastSeen';

/**
 * The last comment you looked at in a thread.
 *
 * The timestamp is not redundant with the id. The id is what stops an inserted
 * reply from moving the mark, but it stops identifying anything once that
 * comment is deleted — and `findIndex` returns -1 for both "deleted" and "never
 * seen", so the whole thread used to light up as new the moment its last
 * comment went away. The timestamp is what the count falls back to.
 */
interface SeenMark {
  id: string;
  /** ISO timestamp of that comment. Empty for a mark written before this field. */
  at: string;
}

/** Marks written by earlier versions were the bare comment id. */
type StoredMark = string | SeenMark;

function toMark(stored: StoredMark): SeenMark {
  return typeof stored === 'string' ? { id: stored, at: '' } : stored;
}

/**
 * Which comments you have already looked at.
 *
 * Kept in workspace state rather than in the session file: it is per-person, and
 * writing it to the shared store would mean every glance produced a write for the
 * agent to notice. Recorded as the id of the last comment seen, so an agent
 * inserting a reply cannot silently move the mark.
 */
export class UnreadTracker {
  private lastSeen: Record<string, SeenMark>;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly memento: vscode.Memento) {
    const stored = memento.get<Record<string, StoredMark>>(STATE_KEY, {});
    this.lastSeen = Object.fromEntries(
      Object.entries(stored).map(([id, mark]) => [id, toMark(mark)]),
    );
  }

  /**
   * Comments added since you last looked, excluding your own.
   *
   * An unknown `me` counts nothing rather than everything. It is empty until the
   * `git config user.name` lookup returns, and a notification that cries wolf on
   * the first render — badging every comment you wrote yourself — is worse than
   * one that is briefly quiet.
   */
  unread(thread: ReviewThreadData, me: string): number {
    if (!me) {
      return 0;
    }
    const mark = this.lastSeen[thread.id];
    if (!mark) {
      return thread.comments.filter((c) => c.author !== me).length;
    }
    const index = thread.comments.findIndex((c) => c.id === mark.id);
    if (index >= 0) {
      return thread.comments.slice(index + 1).filter((c) => c.author !== me).length;
    }
    // The comment we marked is gone — deleted, or hand-written without an id and
    // given a fresh one on every read. Treating that as "never seen" would
    // re-flag the whole thread although nothing arrived, so fall back to time.
    // A mark from before timestamps were stored has nothing to compare against;
    // it stays quiet rather than shouting.
    return mark.at
      ? thread.comments.filter((c) => c.author !== me && c.createdAt > mark.at).length
      : 0;
  }

  markRead(thread: ReviewThreadData): void {
    const last = thread.comments[thread.comments.length - 1];
    if (!last || this.lastSeen[thread.id]?.id === last.id) {
      return;
    }
    this.lastSeen[thread.id] = { id: last.id, at: last.createdAt };
    this.save();
  }

  markAllRead(threads: readonly ReviewThreadData[]): void {
    let changed = false;
    for (const thread of threads) {
      const last = thread.comments[thread.comments.length - 1];
      if (last && this.lastSeen[thread.id]?.id !== last.id) {
        this.lastSeen[thread.id] = { id: last.id, at: last.createdAt };
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  /** Forgets that these threads were read, so everything in them shows as new. */
  markAllUnread(threads: readonly ReviewThreadData[]): void {
    let changed = false;
    for (const thread of threads) {
      if (this.lastSeen[thread.id] !== undefined) {
        delete this.lastSeen[thread.id];
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  /**
   * Drops marks for threads that no longer exist, so the state cannot grow
   * forever.
   *
   * Only ever call this with a set you know to be complete. Read state is the
   * one thing here that cannot be reconstructed, and capping the size of a map
   * is a slow, harmless problem to trade against losing it.
   */
  prune(liveThreadIds: Set<string>): void {
    let changed = false;
    for (const id of Object.keys(this.lastSeen)) {
      if (!liveThreadIds.has(id)) {
        delete this.lastSeen[id];
        changed = true;
      }
    }
    if (changed) {
      void this.memento.update(STATE_KEY, this.lastSeen);
    }
  }

  private save(): void {
    void this.memento.update(STATE_KEY, this.lastSeen);
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
