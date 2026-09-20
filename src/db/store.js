const fs = require('fs');
const path = require('path');
const { buildSeed } = require('./seed');

// A single-file JSON store: whole dataset lives in memory, every mutation is
// flushed with an atomic write (temp file + rename) so a crash mid-write can
// never leave a truncated db.json. Fine for one Node process at village-center
// scale; swap for Postgres/DynamoDB behind this same `data` + `save()` shape
// when you need multiple instances.
class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  init() {
    if (this.file && fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Upgrade path: a db.json written by an older version lacks any
      // collection added since, so backfill those (empty for user data).
      let changed = false;
      for (const [key, value] of Object.entries(buildSeed())) {
        if (!(key in this.data)) {
          this.data[key] = value;
          changed = true;
        }
      }
      if (changed) this.save();
    } else {
      this.data = buildSeed();
      this.save();
    }
    return this;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

const createStore = (file) => new Store(file).init();

module.exports = { createStore };
