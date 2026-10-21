import pg from "pg";

const url = process.env.DATABASE_URL || "";

// Adresse EXTERNE de Render (finit par .render.com) : SSL obligatoire.
// Adresse INTERNE (utilisee par le serveur sur Render) : pas de SSL.
const needsSsl = /\.render\.com/.test(url);

export const pool = url
  ? new pg.Pool({
      connectionString: url,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
      max: 5,
    })
  : null;