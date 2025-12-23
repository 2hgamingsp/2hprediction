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
    // Corrected logic: Ensure the client exists AND the connection is still alive
    if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
        return cachedClient;
    }
    
    if (!uri) throw new Error("MONGODB_URI is not defined");
    
    const client = new MongoClient(uri, { 
        serverSelectionTimeoutMS: 5000,
        useUnifiedTopology: true 
    });
    
    await client.connect();
    cachedClient = client;
    return client;
}

function getCollectionName(league) {
    if (!league) return "matches"; 
    const cleanLeague = league.toString().toLowerCase().trim();
    return `${cleanLeague}_matches`;
}

// --- GET ROUTE ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, homeTeam, awayTeam, compact } = req.query;
        
        if (!league) return res.status(400).json({ error: "League parameter is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

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

        const query = {};
        if (season) query.season = season.toString();
        if (trn) query.trn = trn.toString();
        if (week) query.week = week.toString();

        let cursor = collection.find(query).sort({ season: -1, trn: -1, week: -1 });

        if (compact === "true") {
            cursor = cursor.project({
                _id: 0,
                matches: 1,
                season: 1,
                trn: 1,
                week: 1,
                deviceTime: 1,
                deviceTimestamp: 1 
            });
        }

        const limitValue = (season || trn || week) ? 5000 : 1000;
        const results = await cursor.limit(limitValue).toArray();

        res.status(200).json(results);
        
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- POST ROUTE (MODIFIED & CORRECTED) ---
app.post("/api/api", async (req, res) => {
    try {
        const batch = req.body;

        // CORRECTION: Guard against missing league to prevent crash
        if (!batch.league) {
            return res.status(400).json({ error: "League name is required." });
        }

        const matchData = batch.matches || batch.allMatches;
        if (!matchData || !Array.isArray(matchData) || matchData.length === 0) {
            return res.status(400).json({ error: "No valid match data array provided." });
        }

        const client = await connectToDatabase();
        const db = client.db();
        const collection = db.collection(getCollectionName(batch.league));

        const sanitizedMatches = matchData.map(m => ({
            homeTeam: (m.homeTeam || m.home || "UNKNOWN").toString().toUpperCase().trim(),
            awayTeam: (m.awayTeam || m.away || m.visitor || "UNKNOWN").toString().toUpperCase().trim(),
            homeScore: isNaN(parseInt(m.homeScore)) ? 0 : parseInt(m.homeScore),
            awayScore: isNaN(parseInt(m.awayScore)) ? 0 : parseInt(m.awayScore)
        }));

        // CORRECTION: Ensure all variables exist for the ID string
        const safeSeason = (batch.season || "0").toString();
        const safeTrn = (batch.trn || "0").toString();
        const safeWeek = (batch.week || "0").toString();
        const customId = `${batch.league.toLowerCase()}-${safeSeason}-${safeTrn}-${safeWeek}`;
        
        const updateDoc = {
            league: batch.league.toLowerCase(),
            season: safeSeason,
            trn: safeTrn,
            week: safeWeek,
            matches: sanitizedMatches,
            deviceTime: batch.syncedAt || new Date().toISOString(),   
            deviceTimestamp: batch.timestamp || Date.now(), 
            serverTime: new Date()        
        };

        // CORRECTION: Using $set ensures we don't accidentally overwrite the entire 
        // object if you add more fields later, and upsert: true handles the "Create if not exists"
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