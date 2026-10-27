const D = require("better-sqlite3");
const db = new D("E:/Zeus Slot/data/zeus-test.sqlite");
const tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
console.log("TABLES:", tables.map((x) => x.name).join(", ") || "(none)");
const pools = db.prepare("select tier, seed_amount, current_amount from jackpot_pool").all();
console.log("POOLS:", JSON.stringify(pools));
const users = db.prepare("select count(*) c from users").get();
console.log("USERS:", users.c);
db.close();
