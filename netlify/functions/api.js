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

// --- GET ROUTE ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, homeTeam, awayTeam } = req.query;
        
        if (!league) return res.status(400).json({ error: "League parameter is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

        // SCENARIO 1: Historical Matchup Check
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

        // SCENARIO 2: Filtered Fetch
        const query = {};
        if (season) query.season = season;
        if (trn) query.trn = trn;
        if (week) query.week = week;

        const limitValue = (season || trn || week) ? 0 : 2000;

        const results = await collection.find(query)
            .sort({ season: -1, trn: -1, week: -1 })
            .limit(limitValue) 
            .toArray();

        res.status(200).json(results);
        
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- POST ROUTE (FIXED FOR AWAY TEAM LOGIC) ---
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

        // IMPROVED SANITIZATION
        // This ensures that even if your scraper/frontend sends 'away' instead of 'awayTeam', it still works.
        const sanitizedMatches = matchData.map(m => {
            const hTeam = m.homeTeam || m.home || "UNKNOWN";
            const aTeam = m.awayTeam || m.away || "UNKNOWN";
            
            return {
                homeTeam: hTeam.toString().toUpperCase().trim(),
                awayTeam: aTeam.toString().toUpperCase().trim(),
                homeScore: parseInt(m.homeScore) || 0,
                awayScore: parseInt(m.awayScore) || 0
            };
        });

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