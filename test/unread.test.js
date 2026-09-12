const Module = require('module');
const original = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return { EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} } };
  }
  return original.call(this, request, ...rest);
};
const { UnreadTracker } = require(__dirname + '/../out/unread.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${e ? ' — ' + e : ''}`); };

const store = {};
const tracker = new UnreadTracker({ get: (k, d) => store[k] ?? d, update: (k, v) => { store[k] = v; } });
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
const c = (id, author) => ({ id, author, createdAt: at() });
const thread = { id: 't1', comments: [c('c1', 'Shiranuit'), c('c2', 'claude')] };

check('a never-seen thread counts only other people\'s comments', tracker.unread(thread, 'Shiranuit') === 1);
tracker.markRead(thread);
check('reading clears it', tracker.unread(thread, 'Shiranuit') === 0);
thread.comments.push(c('c3', 'claude'));
check('a new agent reply is unread', tracker.unread(thread, 'Shiranuit') === 1);
thread.comments.push(c('c4', 'Shiranuit'));
check('your own reply is never unread', tracker.unread(thread, 'Shiranuit') === 1);
tracker.markRead(thread);
// Inserted at an earlier position AND an earlier time, which is what an
// insertion is: a later timestamp would make it genuinely new, not misplaced.
thread.comments.splice(1, 0, { id: 'cX', author: 'claude', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500)).toISOString() });
check('the mark is a comment id, so an inserted reply cannot move it', tracker.unread(thread, 'Shiranuit') === 0);
check('persisted to workspace state', store['localReview.lastSeen'].t1.id === 'c4');

// deleting the marked comment must not re-flag the thread: nothing arrived
tracker.markRead(thread);
const dropped = thread.comments.pop();
check('deleting the marked comment does not re-flag the thread', tracker.unread(thread, 'Shiranuit') === 0,
  `${tracker.unread(thread, 'Shiranuit')} reported unread`);
thread.comments.push(c('c5', 'claude'));
check('and a genuinely new comment after it still counts', tracker.unread(thread, 'Shiranuit') === 1,
  `${tracker.unread(thread, 'Shiranuit')} reported unread`);
thread.comments.pop();
thread.comments.push(dropped);

// a mark written before timestamps existed stays quiet rather than shouting
const legacyStore = { 'localReview.lastSeen': { t1: 'gone' } };
const legacy = new UnreadTracker({ get: (k, d) => legacyStore[k] ?? d, update: (k, v) => { legacyStore[k] = v; } });
check('a pre-timestamp mark whose comment is gone counts nothing', legacy.unread(thread, 'Shiranuit') === 0,
  `${legacy.unread(thread, 'Shiranuit')} reported unread`);

// an unresolved author must not badge your own comments
check('an unknown author counts nothing, not everything', tracker.unread(thread, '') === 0,
  `${tracker.unread(thread, '')} reported unread`);
tracker.prune(new Set());
check('marks for deleted threads are pruned', Object.keys(store['localReview.lastSeen']).length === 0);

tracker.markRead(thread);
check('marked read again', tracker.unread(thread, 'Shiranuit') === 0);
tracker.markAllUnread([thread]);
const notMine = thread.comments.filter((c) => c.author !== 'Shiranuit').length;
check('markAllUnread makes everything new again', tracker.unread(thread, 'Shiranuit') === notMine,
  `${tracker.unread(thread, 'Shiranuit')} of ${notMine} comments not by me`);

// resolving must not hide unread activity
const resolved = { id: 't2', status: 'resolved', comments: [c('a', 'Shiranuit'), c('b', 'claude')] };
check('a resolved thread still reports unread', tracker.unread(resolved, 'Shiranuit') === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
