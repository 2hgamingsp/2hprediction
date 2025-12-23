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
    if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
        return cachedClient;
    }
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

// --- UPDATED GET ROUTE ---
app.get("/api/api", async (req, res) => {
    try {
        const { season, trn, week, league, homeTeam, awayTeam } = req.query;
        
        if (!league) return res.status(400).json({ error: "League parameter is required" });

        const client = await connectToDatabase();
        const db = client.db(); 
        const collection = db.collection(getCollectionName(league));

        // SCENARIO 1: Historical Matchup Check (Specific Game History)
        if (homeTeam && awayTeam) {
            const historicalRecords = await collection.find({
                "matches": {
                    $elemMatch: {
                        homeTeam: homeTeam.toUpperCase(),
                        awayTeam: awayTeam.toUpperCase()
                    }
                }
            }).sort({ lastUpdated: -1 }).toArray();

            const response = historicalRecords.map(doc => {
                const match = doc.matches.find(m => 
                    m.homeTeam === homeTeam.toUpperCase() && 
                    m.awayTeam === awayTeam.toUpperCase()
                );
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

        // SCENARIO 2: Dynamic Query (Season, TRN, Week, or Full League for Batch Check)
        const query = {};
        if (season) query.season = season;
        if (trn) query.trn = trn;
        if (week) query.week = week;

        // Fetching records. If no filters, returns all (used for frontend duplicate batch logic)
        const results = await collection.find(query).sort({ season: -1, trn: -1 }).toArray();
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

        // Format team names to uppercase for strict fingerprinting
        const sanitizedMatches = batch.allMatches.map(m => ({
            ...m,
            homeTeam: m.homeTeam.toUpperCase().trim(),
            awayTeam: m.awayTeam.toUpperCase().trim(),
            homeScore: parseInt(m.homeScore),
            awayScore: parseInt(m.awayScore)
        }));

        // ID includes league and season to prevent cross-over overwrites
        const customId = `${batch.league.toLowerCase()}-${batch.season}-TRN${batch.trn}-W${batch.week}`;
        
        await collection.updateOne(
            { _id: customId },
            { 
                $set: {
                    batchId: customId,
                    league: batch.league.toLowerCase(),
                    season: batch.season,
                    trn: batch.trn,
                    week: batch.week,
                    matches: sanitizedMatches,
                    lastUpdated: new Date()
                } 
            },
            { upsert: true }
        );

        res.status(200).json({ success: true, id: customId });
    } catch (error) {
        console.error("Post Error:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports.handler = serverless(app);