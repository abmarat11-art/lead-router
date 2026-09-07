import { openMigrated } from './index.js';

const db = openMigrated();
console.log('migrated:', db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name).join(', '));
