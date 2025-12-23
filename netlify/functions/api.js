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
    // 1. Check if URI exists before trying to use it
    if (!uri) {
        throw new Error("MONGODB_URI is not defined in environment variables");
    }

    if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
        return cachedClient;
    }

    try {
        const client = new MongoClient(uri, { 
            serverSelectionTimeoutMS: 5000,
            // These options help with stability in serverless environments
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

        // SCENARIO 1: Historical Matchup Check (Team vs Team)
        if (homeTeam && awayTeam) {
            const historicalRecords = await collection.find({
                "matches": {
                    $elemMatch: {
                        homeTeam: homeTeam.toUpperCase(),
                        awayTeam: awayTeam.toUpperCase()
                    }
                }
            }).sort({ lastUpdated: -1 }).toArray();

            // Map results to extract the specific match data
            const response = historicalRecords.map(doc => {
                const match = doc.matches.find(m => m.homeTeam === homeTeam.toUpperCase() && m.awayTeam === awayTeam.toUpperCase());
                return {
                    homeTeam: match.homeTeam,
                    awayTeam: match.awayTeam,
                    homeScore: match.homeScore,
                    awayScore: match.awayScore,
                    season: doc.season,
                    trn: doc.trn,
                    week: doc.week
                };
            });

            return res.status(200).json(response);
        }

        // SCENARIO 2: Specific Filter or Full League Fetch
        const query = {};
        if (season) query.season = season;
        if (trn) query.trn = trn;
        if (week) query.week = week;

        // If no specific filters (season/trn/week) are provided, 
        // this will return all records for the duplicate batch check.
        const results = await collection.find(query).sort({ lastUpdated: -1 }).toArray();
        res.status(200).json(results);
        
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- POST ROUTE (UPSERT LOGIC) ---
app.post("/api/api", async (req, res) => {
    try {
        const batch = req.body;
        if (!batch.allMatches || batch.allMatches.length === 0) {
            return res.status(400).json({ error: "No match data provided." });
        }

        const client = await connectToDatabase();
        const db = client.db();
        const collection = db.collection(getCollectionName(batch.league));

        // Consistent ID format for easy lookup/overwriting
        const customId = `${batch.league}-${batch.season}-TRN${batch.trn}-W${batch.week}`;
        
        await collection.updateOne(
            { _id: customId },
            { 
                $set: {
                    batchId: customId,
                    league: batch.league,
                    season: batch.season,
                    trn: batch.trn,
                    week: batch.week,
                    matches: batch.allMatches,
                    lastUpdated: new Date()
                } 
            },
            { upsert: true }
        );

        res.status(200).json({ success: true, id: customId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);