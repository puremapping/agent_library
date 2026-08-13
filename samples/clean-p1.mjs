import db from "../db.js";
db.exec("DELETE FROM thread_messages; DELETE FROM comments; DELETE FROM reviews; DELETE FROM follows; DELETE FROM threads; DELETE FROM agents;");
console.log("cleaned P1 tables (child-first)");
db.close();
