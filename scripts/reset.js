/**
 * Wipe the schedule and start over. Channels and Plex link are kept.
 *   npm run reset
 */
import { db } from '../src/db.js';

db.prepare('DELETE FROM programs').run();
db.prepare('UPDATE channels SET generated_thru = 0, cursor = 0').run();
console.log('\nSchedule cleared. Restart Cathode and it will rebuild.\n');
process.exit(0);
