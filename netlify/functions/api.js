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

/**
 * Helper to generate comparison keys (Fingerprints)
 */
const getFingerprints = (matches) => {
    if (!matches || matches.length === 0) return {};
    
    const getH = (m) => (m.homeTeam || m.home || "").trim().toLowerCase();
    const getA = (m) => (m.awayTeam || m.away || m.visitor || "").trim().toLowerCase();

    const exact = matches.map(m => `${getH(m)}:${m.homeScore}-${m.awayScore}:${getA(m)}`).join('|');
    const scrambled = matches.map(m => `${getH(m)}:${m.homeScore}-${m.awayScore}:${getA(m)}`).sort().join('|');
    const outcome = matches.map(m => `${m.homeScore}-${m.awayScore}`).join('|');
    const pairingSeq = matches.map(m => `${getH(m)}v${getA(m)}`).join('|');
    const pairingScrambled = matches.map(m => `${getH(m)}v${getA(m)}`).sort().join('|');

    return { exact, scrambled, outcome, pairingSeq, pairingScrambled };
};

// --- GET ROUTE ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, compact, homeTeam, awayTeam } = req.query;
        if (!league) return res.status(400).json({ error: "League parameter is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

        // Scenario 1: Specific Matchup Search
        if (homeTeam && awayTeam) {
            const history = await collection.find({
                "matches": { $elemMatch: { 
                    homeTeam: homeTeam.toUpperCase().trim(), 
                    awayTeam: awayTeam.toUpperCase().trim() 
                }}
            }).project({ matches: 1, season: 1, trn: 1, week: 1 }).limit(50).toArray();
            return res.status(200).json(history);
        }

        // Scenario 2: Standard Fetch + Pattern Analysis
        const query = {};
        if (season) query.season = season.toString();
        if (trn) query.trn = trn.toString();
        if (week) query.week = week.toString();

        const results = await collection.find(query).sort({ season: -1, trn: -1, week: -1 }).toArray();

        // If user is looking for a specific week, we perform the "Duplicate Scan"
        if (season && trn && week && results.length > 0) {
            const currentWeek = results[0];
            const currentKeys = getFingerprints(currentWeek.matches);
            
            // Fetch all other weeks in this league to compare
            const allOtherWeeks = await collection.find({ 
                _id: { $ne: currentWeek._id } 
            }).project({ matches: 1, season: 1, trn: 1, week: 1 }).toArray();

            const alerts = [];
            allOtherWeeks.forEach(pastWeek => {
                const pastKeys = getFingerprints(pastWeek.matches);

                if (currentKeys.exact === pastKeys.exact) {
                    alerts.push({ type: "EXACT SEQUENCE MATCH", color: "indigo", data: pastWeek });
                } else if (currentKeys.scrambled === pastKeys.scrambled) {
                    alerts.push({ type: "REARRANGED SEQUENCE", color: "amber", data: pastWeek });
                } else if (currentKeys.pairingScrambled === pastKeys.pairingScrambled) {
                    alerts.push({ type: "TEAM PATTERN MATCH", color: "emerald", data: pastWeek });
                } else if (currentKeys.pairingSeq === pastKeys.pairingSeq) {
                    alerts.push({ type: "IDENTICAL FIXTURE LIST", color: "cyan", data: pastWeek });
                } else if (currentKeys.outcome === pastKeys.outcome) {
                    alerts.push({ type: "SCORE PATTERN MATCH", color: "rose", data: pastWeek });
                }
            });

            // Return both the matches and the pattern alerts
            return res.status(200).json({ matches: currentWeek.matches, alerts });
        }

        res.status(200).json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- POST ROUTE ---
app.post("/api/api", async (req, res) => {
    try {
        const batch = req.body;
        const matchData = batch.matches || batch.allMatches;
        if (!matchData) return res.status(400).json({ error: "No data" });

        const client = await connectToDatabase();
        const db = client.db();
        const collection = db.collection(getCollectionName(batch.league));

        const sanitizedMatches = matchData.map(m => ({
            homeTeam: (m.homeTeam || m.home || "N/A").toString().toUpperCase().trim(),
            awayTeam: (m.awayTeam || m.away || "N/A").toString().toUpperCase().trim(),
            homeScore: parseInt(m.homeScore) || 0,
            awayScore: parseInt(m.awayScore) || 0
        }));

        const customId = `${batch.league.toLowerCase()}-${batch.season}-${batch.trn}-${batch.week}`;
        const updateDoc = {
            _id: customId,
            league: batch.league.toLowerCase(),
            season: batch.season.toString(),
            trn: batch.trn.toString(),
            week: batch.week.toString(),
            matches: sanitizedMatches,
            lastUpdated: new Date()
        };

        await collection.updateOne({ _id: customId }, { $set: updateDoc }, { upsert: true });
        res.status(200).json({ success: true, id: customId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);