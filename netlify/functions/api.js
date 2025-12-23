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
    if (!uri) {
        throw new Error("MONGODB_URI is not defined in environment variables");
    }
    if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
        return cachedClient;
    }
    try {
        const client = new MongoClient(uri, { 
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 10000, 
        });
        await client.connect();
        cachedClient = client;
        return client;
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err);
        throw err;
    }
}

function getCollectionName(league) {
    if (!league) return "matches"; 
    const cleanLeague = league.toLowerCase().trim();
    return `${cleanLeague}_matches`;
}

// --- UPDATED GET ROUTE ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, homeTeam, awayTeam } = req.query;
        
        if (!league) return res.status(400).json({ error: "League parameter is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

        // SCENARIO 1: Historical Matchup Check (Single Game History)
        if (homeTeam && awayTeam) {
            const historicalRecords = await collection.find({
                "matches": {
                    $elemMatch: {
                        homeTeam: homeTeam.toUpperCase().trim(),
                        awayTeam: awayTeam.toUpperCase().trim()
                    }
                }
            }).sort({ season: -1, trn: -1 }).toArray();

            const response = historicalRecords.map(doc => {
                const match = doc.matches.find(m => 
                    m.homeTeam === homeTeam.toUpperCase().trim() && 
                    m.awayTeam === awayTeam.toUpperCase().trim()
                );
                return {
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    homeScore: match.homeScore,
                    awayScore: match.awayScore,
                    season: doc.season,
                    trn: doc.trn,
                    week: doc.week,
                    lastUpdated: doc.lastUpdated
                };
            });

            return res.status(200).json(response);
        }

        // SCENARIO 2: Specific Filter or Full League Fetch (for Pattern Detection)
        const query = {};
        if (season) query.season = season;
        if (trn) query.trn = trn;
        if (week) query.week = week;

        // Limiting to last 1000 records if no specific query is provided 
        // to prevent overloading the frontend during pattern scans
        const results = await collection.find(query)
            .sort({ season: -1, trn: -1, week: -1 })
            .limit(query.trn ? 0 : 1000) 
            .toArray();

        res.status(200).json(results);
        
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- UPDATED POST ROUTE ---
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

        // Sanitize match data: Trim and Uppercase for accurate fingerprinting
        const sanitizedMatches = matchData.map(m => ({
            homeTeam: m.homeTeam.toUpperCase().trim(),
            awayTeam: m.awayTeam.toUpperCase().trim(),
            homeScore: parseInt(m.homeScore),
            awayScore: parseInt(m.awayScore)
        }));

        // Unique ID ensures we don't double-save the same Week/TRN
        const customId = `${batch.league.toLowerCase()}-${batch.season}-T${batch.trn}-W${batch.week}`;
        
        const updateDoc = {
            batchId: customId,
            league: batch.league.toLowerCase(),
            season: batch.season,
            trn: batch.trn,
            week: batch.week,
            matches: sanitizedMatches,
            lastUpdated: new Date()
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