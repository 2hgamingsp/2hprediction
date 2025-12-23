const express = require("express");
const serverless = require("serverless-http");
const cors = require("cors");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(cors()); 
app.use(express.json());

const uri = process.env.MONGODB_URI;
let cachedClient = null;

async function connectToDatabase() {
    if (!uri) throw new Error("MONGODB_URI is not defined");
    if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
        return cachedClient;
    }
    const client = new MongoClient(uri, { 
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000, 
    });
    await client.connect();
    cachedClient = client;
    return client;
}

function getCollectionName(league) {
    return `${(league || "matches").toLowerCase().trim()}_matches`;
}

// --- CORE PATTERN FINGERPRINTING ---
const getFingerprints = (matches) => {
    if (!matches || matches.length === 0) return {};
    const clean = (t) => (t || "").toString().trim().toLowerCase();

    // Exact Sequence: "team:score-score:team|..."
    const exact = matches.map(m => `${clean(m.homeTeam)}:${m.homeScore}-${m.awayScore}:${clean(m.awayTeam)}`).join('|');
    // Scrambled (Rearranged): Sort alphabetically so order doesn't matter
    const scrambled = matches.map(m => `${clean(m.homeTeam)}:${m.homeScore}-${m.awayScore}:${clean(m.awayTeam)}`).sort().join('|');
    // Score Pattern: "0-2|1-0|..."
    const scores = matches.map(m => `${m.homeScore}-${m.awayScore}`).join('|');
    // Team Pattern: "teamvsteam" sorted alphabetically
    const teams = matches.map(m => [clean(m.homeTeam), clean(m.awayTeam)].sort().join('v')).sort().join('|');

    return { exact, scrambled, scores, teams };
};

// --- OPTIMIZED GET ROUTE ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, homeTeam, awayTeam } = req.query;
        if (!league) return res.status(400).json({ error: "League is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

        // Ensure database is indexed for speed
        await collection.createIndex({ season: -1, trn: -1, week: -1 });

        // CASE 1: SEARCHING FOR A SPECIFIC MATCHUP
        if (homeTeam && awayTeam) {
            const history = await collection.find({
                "matches": { $elemMatch: { 
                    homeTeam: homeTeam.toUpperCase().trim(), 
                    awayTeam: awayTeam.toUpperCase().trim() 
                }}
            }).project({ matches: 1, season: 1, trn: 1, week: 1 }).sort({ season: -1 }).limit(50).toArray();
            return res.status(200).json(history);
        }

        // CASE 2: SEARCHING BY SEASON/TRN/WEEK (WITH INSTANT SCAN)
        if (season && trn && week) {
            // Fetch the ENTIRE league history in one go, but only the fields we need
            // This is the "Full Scan" that prevents the frontend from waiting
            const allRecords = await collection.find({})
                .project({ _id: 1, season: 1, trn: 1, week: 1, matches: 1 })
                .sort({ season: -1, trn: -1, week: -1 })
                .toArray();

            const requested = allRecords.find(r => 
                r.season == season && r.trn == trn && r.week == week
            );

            if (!requested) return res.status(404).json({ error: "Record not found" });

            // RUN PATTERN ANALYSIS ON SERVER
            const currentKeys = getFingerprints(requested.matches);
            const alerts = [];

            allRecords.forEach(past => {
                if (past._id === requested._id) return; // Skip itself
                const pastKeys = getFingerprints(past.matches);

                if (currentKeys.exact === pastKeys.exact) {
                    alerts.push({ type: "EXACT SEQUENCE MATCH", color: "indigo", data: past });
                } else if (currentKeys.scrambled === pastKeys.scrambled) {
                    alerts.push({ type: "REARRANGED SEQUENCE", color: "amber", data: past });
                } else if (currentKeys.teams === pastKeys.teams) {
                    alerts.push({ type: "TEAM PATTERN MATCH", color: "emerald", data: past });
                } else if (currentKeys.scores === pastKeys.scores) {
                    alerts.push({ type: "SCORE PATTERN MATCH", color: "rose", data: past });
                }
            });

            // Return the requested week AND the identified historical patterns
            return res.status(200).json({
                main: requested,
                alerts: alerts
            });
        }

        // FALLBACK: Return list (limited for performance)
        const results = await collection.find({}).sort({ season: -1, trn: -1, week: -1 }).limit(100).toArray();
        res.status(200).json(results);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- POST ROUTE (STAYS THE SAME) ---
app.post("/api/api", async (req, res) => {
    try {
        const batch = req.body;
        const matchData = batch.matches || batch.allMatches;
        if (!matchData) return res.status(400).json({ error: "No data" });

        const client = await connectToDatabase();
        const db = client.db();
        const collection = db.collection(getCollectionName(batch.league));

        const sanitized = matchData.map(m => ({
            homeTeam: (m.homeTeam || m.home || "N/A").toString().toUpperCase().trim(),
            awayTeam: (m.awayTeam || m.away || "N/A").toString().toUpperCase().trim(),
            homeScore: parseInt(m.homeScore) || 0,
            awayScore: parseInt(m.awayScore) || 0
        }));

        const customId = `${batch.league.toLowerCase()}-${batch.season}-${batch.trn}-${batch.week}`;
        await collection.updateOne(
            { _id: customId },
            { $set: {
                _id: customId,
                league: batch.league.toLowerCase(),
                season: batch.season.toString(),
                trn: batch.trn.toString(),
                week: batch.week.toString(),
                matches: sanitized,
                lastUpdated: new Date()
            }},
            { upsert: true }
        );
        res.status(200).json({ success: true, id: customId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);