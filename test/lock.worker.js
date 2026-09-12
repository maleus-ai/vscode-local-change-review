const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquire, release } = require(process.env.LOCK_MODULE || __dirname + '/../out/core/lock.js');
const [lock, journal, rounds] = [process.argv[2], process.argv[3], Number(process.argv[4])];

// A dead lock, the way a crashed writer leaves one. Assembled complete and
// renamed into place, with the owner file pre-aged, so planting it can never
// re-date or overwrite a lock another process is legitimately holding — that
// would be corruption rather than the staleness we mean to simulate.
const dead = `999999-dead-${process.pid}`;
const plant = () => {
  const staging = `${lock}.plant.${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    const file = path.join(staging, dead);
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, host: os.hostname(), startedAt: 0 }));
    fs.utimesSync(file, new Date(0), new Date(0));
    fs.renameSync(staging, lock);
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* hold it */ } };

for (let i = 0; i < rounds; i++) {
  plant();
  try {
    const token = acquire(lock, 20000);
    fs.appendFileSync(journal, `IN ${process.pid}\n`);
    spin(5);
    fs.appendFileSync(journal, `OUT ${process.pid}\n`);
    if (!release(lock, token)) {
      fs.appendFileSync(journal, `LOST ${process.pid}\n`);
    }
  } catch { /* timed out */ }
}
