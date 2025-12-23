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
    if (cachedClient) return cachedClient;
    if (!uri) throw new Error("MONGODB_URI is not defined");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    cachedClient = client;
    return client;
}

function getCollectionName(league) {
    if (!league) return "matches"; 
    const cleanLeague = league.toLowerCase().trim();
    return `${cleanLeague}_matches`;
}

// --- GET ROUTE (OPTIMIZED FOR TIMELINE) ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, homeTeam, awayTeam, compact } = req.query;
        
        if (!league) return res.status(400).json({ error: "League parameter is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

        // SCENARIO 1: Historical Matchup Check (Unchanged)
        if (homeTeam && awayTeam) {
            const hTeam = homeTeam.toUpperCase().trim();
            const aTeam = awayTeam.toUpperCase().trim();

            const historicalRecords = await collection.find({
                "matches": { $elemMatch: { homeTeam: hTeam, awayTeam: aTeam } }
            })
            .project({ "matches.$": 1, season: 1, trn: 1, week: 1 }) 
            .sort({ season: -1 })
            .limit(50)
            .toArray();

            const response = historicalRecords.map(doc => ({
                ...doc.matches[0],
                season: doc.season,
                trn: doc.trn,
                week: doc.week
            }));

            return res.status(200).json(response);
        }

        // SCENARIO 2: Filtered Fetch / Timeline / Duplicate Scan
        const query = {};
        // Convert to string to match how you save them in the POST route
        if (season) query.season = season.toString();
        if (trn) query.trn = trn.toString();
        if (week) query.week = week.toString();

        // SORTING: Newest Season -> Newest TRN -> Newest Week
        // This ensures the "Latest" result is always at results[0]
        let cursor = collection.find(query).sort({ season: -1, trn: -1, week: -1 });

        if (compact === "true") {
            cursor = cursor.project({
                _id: 0,
                matches: 1,
                season: 1,
                trn: 1,
                week: 1,
                deviceTime: 1,      // ADDED: Needed for frontend labels
                deviceTimestamp: 1   // ADDED: Helpful for secondary sorting
            });
        }

        // If specific TRN or Season is requested, return everything found (no limit)
        // If it's a general "fetch everything" request, keep the 1000 limit
        const limitValue = (season || trn || week) ? 5000 : 1000;
        const results = await cursor.limit(limitValue).toArray();

        res.status(200).json(results);
        
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- POST ROUTE (KEEPING YOUR LOGIC) ---
app.post("/api/api", async (req, res) => {
    try {
        const batch = req.body;
        const matchData = batch.matches || batch.allMatches;

        if (!matchData || matchData.length === 0) {
            return res.status(400).json({ error: "No match data provided." });
        }

        const client = await connectToDatabase();
        const db = client.db();
        const collection = db.collection(getCollectionName(batch.league));

        const sanitizedMatches = matchData.map(m => ({
            homeTeam: (m.homeTeam || m.home || "UNKNOWN").toString().toUpperCase().trim(),
            awayTeam: (m.awayTeam || m.away || m.visitor || "UNKNOWN").toString().toUpperCase().trim(),
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
            deviceTime: batch.syncedAt,   
            deviceTimestamp: batch.timestamp, 
            serverTime: new Date()        
        };

        const result = await collection.updateOne(
            { _id: customId },
            { $set: updateDoc },
            { upsert: true }
        );

        res.status(200).json({ 
            success: true, 
            id: customId, 
            action: result.upsertedCount > 0 ? "created" : "updated" 
        });

    } catch (error) {
        console.error("Post Error:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);