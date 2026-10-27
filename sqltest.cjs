const D = require('/opt/zeus-slot/node_modules/better-sqlite3');
const db = new D(':memory:');
db.exec('create table t(a)');
db.prepare('insert into t values (?)').run(42);
console.log('SQLITE_NATIVE_OK node', process.version, 'row=', db.prepare('select a from t').get().a);
