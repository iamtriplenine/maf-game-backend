import { referralRouter } from './referralRoutes.js';
import { partnerAccountsRouter } from './partnerAccounts.js';
import express from "express";
import cors from "cors";
import { walletRouter } from "./wallet.js";
import { winPracticeRouter } from "./winPractice.js";
import { tournamentsRouter } from "./tournaments.js";
import { tournamentGiftRouter, maintainTournamentGiftClock } from "./tournamentGiftCenter.js";
import { tournamentQualificationRouter, maintainQualificationStarts, maintainQualificationMatches } from "./tournamentQualificationStart.js";
import { tournamentFinalistsRouter, maintainFinalistArrivals } from "./tournamentFinalists.js";
import { tournamentFinaleRouter, maintainFinaleStarts, maintainFinaleMatches } from "./tournamentFinale.js";
import { tournamentAwardsRouter, maintainTournamentAwardCredits } from "./tournamentAwards.js";
import { tournamentSkinsRouter } from "./tournamentSkins.js";
import { tournamentCancellationRouter, maintainTournamentCancellations } from "./tournamentCancellation.js";
import { pool } from "./db.js";
import { ownerGiftsRouter } from "./ownerGifts.js";
import { authRouter } from "./auth.js";
import { chatRouter } from "./chat.js";
import { roomsRouter, maintainRooms } from "./rooms.js";
import { monopolyRoomsRouter, maintainMonopolyRooms } from "./monopolyRooms.js";
import { monopolyVoicesRouter, ensureMonopolyVoices } from "./monopolyVoices.js";
import { historyRouter } from "./history.js";
import { ownerNotificationsRouter } from "./ownerNotifications.js"; // MAF_OWNER_ALERTS_V1

import {tournamentDuelRouter,maintainTournamentDuels} from './tournamentDuel.js';

const app = express();
// Derriere Render : l'adresse du visiteur vient du proxy (non falsifiable), pas d'un en-tete envoye par le client.
app.set("trust proxy", 1);
app.use(express.json({ limit: "3mb" }));

// Adresses du site autorisees a appeler ce serveur (separees par des virgules).
// Sur Render : variable FRONT_ORIGINS. En local : http://localhost:5173
const origins = (process.env.FRONT_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
app.use(cors({ origin: (origin, done) => done(null, !origin || origins.includes(origin) || /\.app\.github\.dev$/.test(origin)) }));

app.get("/", (_req, res) => {
  res.json({ name: "maf-game-backend", ok: true });
});

// Test de vie + test de la connexion a la base de donnees
app.get("/health", async (_req, res) => {
  if (!pool) {
    return res.json({ ok: true, db: "non configuree (DATABASE_URL vide)" });
  }
  try {
    const result = await pool.query("select now() as now");
    res.json({ ok: true, db: "ok", now: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ ok: false, db: "erreur", message: error.message });
  }
});

app.use("/api", referralRouter);
app.use("/api", authRouter); // /api/register, /api/login, /api/me

app.use("/api", chatRouter); // /api/chat

app.use("/api/monopoly/rooms", monopolyRoomsRouter);
app.use("/api/monopoly/voices", monopolyVoicesRouter);
app.use("/api/rooms", roomsRouter); // Salons et tir au but (etape 2)

app.use("/api", walletRouter);
app.use("/api/win-practice", winPracticeRouter);
app.use("/api/tournaments", tournamentCancellationRouter);
app.use("/api/tournaments", tournamentQualificationRouter);
app.use("/api/tournaments", tournamentFinalistsRouter);
app.use("/api/tournaments", tournamentFinaleRouter);
app.use("/api/tournaments", tournamentAwardsRouter);
app.use("/api/tournaments", tournamentSkinsRouter);
app.use("/api/tournaments/duels", tournamentDuelRouter);
app.use("/api/tournaments", tournamentsRouter);
app.use("/api/tournaments", tournamentGiftRouter);
app.use("/api/gifts", ownerGiftsRouter);
app.use("/api/history", historyRouter);
app.use("/api", partnerAccountsRouter);
app.use("/api/owner", ownerNotificationsRouter);
app.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") return res.status(413).json({ error: "Capture trop volumineuse (2 Mo maximum)." });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "JSON invalide." });
  console.error(error.message);
  res.status(500).json({ error: "Erreur serveur." });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Serveur pret sur le port ${port}`);
});
// Also settle timeouts when both players have left the screen.
setInterval(() => { void maintainRooms().catch(error => console.error("room maintenance:", error.message)); }, 1000).unref();
void maintainRooms().catch(error => console.error("room maintenance:", error.message));

// En attente : fermer les salons expires ; en partie : rembourser les mises si 24 h sans action.
setInterval(() => { void maintainMonopolyRooms().catch(error => console.error("monopoly maintenance:", error.message)); }, 2_000).unref();

// Preparer les vocaux prives et leur suppression automatique a la fin d'un match.
void ensureMonopolyVoices().catch(error => console.error("monopoly voices setup:", error.message));

// Etape 3 : rattrapage des tournois incomplets apres demarrage ou reveil du serveur.
setInterval(() => { void maintainTournamentCancellations().catch(error => console.error("tournament cancellations:",error.message)); }, 30000).unref();
void maintainTournamentCancellations().catch(error => console.error("tournament cancellations setup:",error.message));

// Etape 5 : rattrapage serveur, sans dependance a un onglet navigateur.
// Le vrai lancement reste desactive tant que MAF_TOURNAMENT_REAL_START_ENABLED n'est pas 'true'.
setInterval(() => { void maintainQualificationStarts().catch(e => console.error('tournament start:', e.message)); }, 30000).unref();
void maintainQualificationStarts().catch(e => console.error('tournament start setup:', e.message));
setInterval(() => { void maintainQualificationMatches().catch(e=>console.error('tournament presence:',e.message)); },5000).unref();

// Etape 6 : recuperation des gagnants enregistres apres une interruption.
setInterval(() => { void maintainFinalistArrivals().catch(e => console.error('tournament finalists:',e.message)); },30000).unref();
void maintainFinalistArrivals().catch(e => console.error('tournament finalists setup:',e.message));

// Etape 7 : maintenance serveur, aucun depart reel par defaut.
setInterval(() => { void maintainFinaleStarts().catch(e => console.error('finale maintenance:',e.message)); },30000).unref();
setInterval(() => { void maintainFinaleMatches().catch(e => console.error('finale live:',e.message)); },5000).unref();
setInterval(() => { void maintainTournamentGiftClock().catch(e => console.error('tournament gifts clock:',e.message)); },30000).unref();
void maintainFinaleStarts().catch(e => console.error('finale setup:',e.message));
setInterval(() => { void maintainTournamentAwardCredits().catch(e => console.error('tournoi recompenses:',e.message)); },30000).unref();

// Duel programme: rattrapage apres reveil, redemarrage et indisponibilite temporaire.
setInterval(() => { void maintainTournamentDuels().catch(e => console.error("duel maintenance:",e.message)); },30000).unref();
void maintainTournamentDuels().catch(e => console.error("duel initialisation:",e.message));
