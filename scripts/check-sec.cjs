const D = require("better-sqlite3");
const db = new D("E:/Zeus Slot/data/sec-test.sqlite");
console.log("USERS:", JSON.stringify(db.prepare("select id, unionId, role from users").all()));
console.log("SESSIONS:", JSON.stringify(db.prepare("select id, user_id from game_sessions").all()));
console.log("BALANCES:", JSON.stringify(db.prepare("select user_id, currency, available from balances").all()));
db.close();
