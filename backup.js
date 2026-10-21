// Sauvegarde simple : exporte toutes les tables de la base dans un fichier JSON.
// Usage : npm run backup   (avec DATABASE_URL = adresse EXTERNE dans le fichier .env)
import fs from "node:fs";
import { pool } from "./db.js";

if (!pool) {
  console.error("DATABASE_URL est vide. Colle l'adresse EXTERNE de la base dans le fichier .env");
  process.exit(1);
}

const tables = await pool.query(
  "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
);

const data = {};
for (const { table_name: name } of tables.rows) {
  const rows = await pool.query(`select * from "${name}"`);
  data[name] = rows.rows;
  console.log(`${name} : ${rows.rowCount} ligne(s)`);
}

fs.mkdirSync("backups", { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const file = `backups/backup-${stamp}.json`;
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`Sauvegarde ecrite : ${file}`);

await pool.end();