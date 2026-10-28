// How to use db.js. Run: npm run example
import db from './db.js';

const whichServer = async (fn) => {
  const { rows: [r] } = await fn('SELECT pg_is_in_recovery() AS replica');
  return r.replica ? 'REPLICA' : 'PRIMARY';
};

try {
  // Where each function runs
  console.log('db.read        ->', await whichServer(db.read));
  console.log('db.readPrimary ->', await whichServer(db.readPrimary));
  console.log('db.write       ->', await whichServer(db.write));

  // Writes go to the primary
  await db.write(`
    CREATE TABLE IF NOT EXISTS example_members (
      id     serial PRIMARY KEY,
      name   text NOT NULL,
      points int  NOT NULL DEFAULT 0 CHECK (points >= 0)
    )`);
  const { rows: [asha] } = await db.write(
    'INSERT INTO example_members (name, points) VALUES ($1, $2) RETURNING *', ['Asha', 500]);
  const { rows: [ravi] } = await db.write(
    'INSERT INTO example_members (name, points) VALUES ($1, $2) RETURNING *', ['Ravi', 200]);

  // Right after a write, read from the primary (the replica may be a few ms behind)
  const { rows: fresh } = await db.readPrimary('SELECT name, points FROM example_members WHERE id = $1', [asha.id]);
  console.log('\nreadPrimary right after insert:', fresh[0]);

  // Transaction: both updates happen, or neither does
  await db.transaction(async (tx) => {
    await tx.query('UPDATE example_members SET points = points - $2 WHERE id = $1', [asha.id, 100]);
    await tx.query('UPDATE example_members SET points = points + $2 WHERE id = $1', [ravi.id, 100]);
  });
  console.log('transfer 100 Asha -> Ravi: committed');

  // A failing transaction rolls back everything, including statements that already succeeded
  try {
    await db.transaction(async (tx) => {
      await tx.query('UPDATE example_members SET points = points + $2 WHERE id = $1', [ravi.id, 9999]);
      await tx.query('UPDATE example_members SET points = points - $2 WHERE id = $1', [asha.id, 9999]); // CHECK fails
    });
  } catch (err) {
    console.log('transfer 9999 Asha -> Ravi: rolled back,', err.message);
  }

  // Normal reads go to the replica
  const { rows } = await db.read('SELECT name, points FROM example_members ORDER BY id');
  console.log('\nread from replica:', rows);

  console.log('\nhealth:', await db.health());
} finally {
  await db.write('DROP TABLE IF EXISTS example_members');
  await db.close();
}
