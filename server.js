// server.js
import dotenv from "dotenv";
dotenv.config();

import pool from "./db/pool.js";
import { DOCTOR_CONTRACT } from "./config/constants.js";
import { deriveChiefComplaint, runTriageController } from "./services/triage.js";

import conversationsRoutes from "./routes/conversations.js";
import chatRoutes from "./routes/chat.js";

import express from "express";
import cors from "cors";

import OpenAI from "openai";

import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

import pkg from "express-openid-connect";
const { auth, requiresAuth } = pkg;

import fetch from "node-fetch";
import { searchMedlinePlus, fetchMedlinePlusSummary } from "./medlineplus.js";
import medicationScannerRoutes from "./routes/medScannerRoutes.js";

import multer from "multer";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

async function extractPdfText(buffer) {
  const uint8 = new Uint8Array(buffer);

  const loadingTask = pdfjsLib.getDocument({ data: uint8 });
  const pdf = await loadingTask.promise;

  let text = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
  }
  return text.trim();
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "");
}

// Create Express app
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(".")); // serves index.html, script.js, etc.

const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH0_SECRET,
  baseURL: 'http://localhost:3000',
  clientID: 'x8Wf2xOu0Ipy03DSCejeXehuCTaOgfjC',
  issuerBaseURL: 'https://dev-aidoctor.ca.auth0.com'
};

// auth router attaches /login, /logout, and /callback routes to the baseURL
app.use(auth(config));

// req.isAuthenticated is provided from the auth router
app.get('/', (req, res) => {
  res.send(req.oidc.isAuthenticated() ? 'Logged in' : 'Logged out');
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 0, fetch, logLevel: "debug"
});

app.use(medicationScannerRoutes({ openai }));

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;

    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)} ms)`
    );
  });

  next();
});

const upload = multer({ dest: "uploads/" });
app.post("/scan-report", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const mime = req.file.mimetype;

    let extractedText = "";

    // 1) If PDF, try direct text extraction first
    if (mime === "application/pdf") {
      const buffer = fs.readFileSync(filePath);
      extractedText = await extractPdfText(buffer);
      console.log("Extracted PDF text length:", extractedText.length);
}

    // 2) If no text (or not a PDF), fall back to OCR
    // Threshold: if PDF text is too short, it's probably a scanned PDF
    if (!extractedText || extractedText.length < 50) {
      const formData = new FormData();
      formData.append("file", fs.createReadStream(req.file.path), {
  filename: req.file.originalname,          // IMPORTANT
  contentType: req.file.mimetype            // IMPORTANT
})

      const ocrResponse = await axios.post(
        "http://localhost:5001/ocr",
        formData,
        { headers: formData.getHeaders() }
      );

      extractedText = (ocrResponse.data.text || "").trim();
    }

    fs.unlinkSync(filePath);

    // 3) Send extracted text to GPT for report analysis
    const gpt = await openai.responses.create({
      model: "gpt-5-mini",
      input: `
Analyze this medical report text.

Output format:
- Summary (2–4 bullets)
- Key findings (bullets)
- Abnormal values (if any)
- What it could mean (general)
- Questions to ask a doctor
- Urgent red flags (only if present)

TEXT:
${extractedText}
`
    });

    res.json({ analysis: gpt.output_text });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Report analysis failed" });
  }
});

async function extractMedicalTopic(userText) {
  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: `
Extract the main medical symptom or condition from this message.

Return JSON only:
{
  "topic": "single medical term"
}

User message:
${userText}
`
  });

  return JSON.parse(response.output_text).topic;
}

app.post("/search-condition", async (req, res) => {
  try {
    const q = (req.body?.query || "").trim();
    if (!q) return res.status(400).json({ error: "Missing query" });

    // ✅ NEW: extract medical topic first
    const topic = await extractMedicalTopic(q);
    console.log("Extracted topic:", topic);

    // search MedlinePlus using extracted topic
    const hits = await searchMedlinePlus(topic);

    if (!hits.length) {
      return res.json({
        input: q,
        extracted: topic,
        answer: "No MedlinePlus results found.",
        sources: []
      });
    }

    const top = hits[0];
    console.log("TOP URL:", top.url);
    const fullSummary = await fetchMedlinePlusSummary(top.url);
    console.log("SUMMARY LEN:", fullSummary?.length || 0);

    return res.json({
      input: q,
      extracted: topic,
      topic: top.title,
      answer: fullSummary || top.snippet,
      sources: hits.map(h => ({ title: h.title, url: h.url })),
      source: "MedlinePlus"
    });

    
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const userIdCache = new Map();

async function getOrCreateDbUser(req) {
  if (!req.oidc?.isAuthenticated()) return null;

  const sub = req.oidc.user.sub;
  const email = req.oidc.user.email || null;
  const name = req.oidc.user.name || null;

  const cached = userIdCache.get(sub);
  if (cached !== undefined) return cached;

  const existing = await pool.query(
    "SELECT id FROM users WHERE auth0_sub=$1",
    [sub]
  );

  if (existing.rows.length) {
    const userId = existing.rows[0].id;
    userIdCache.set(sub, userId);
    return existing.rows[0].id;
  }

  const created = await pool.query(
    "INSERT INTO users (auth0_sub, email, name) VALUES ($1,$2,$3) RETURNING id",
    [sub, email, name]
  );
  const userId = created.rows[0].id;
  userIdCache.set(sub, userId);
  return created.rows[0].id;
}

app.get("/test-db-live", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.oidc?.isAuthenticated()) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.oidc.user });
});



app.use(
  "/api/conversations",
  conversationsRoutes(pool, getOrCreateDbUser, requiresAuth)
);

app.use(
  "/api/chat",
  chatRoutes(pool, openai, getOrCreateDbUser, requiresAuth)
);


// ---- Conversation state (single-user MVP) ----
const sessions = new Map();

function createSession() {
  return {
    messages: [
      { role: "developer", content: DOCTOR_CONTRACT },
  { role: "assistant",
    content:
      "Hello — I'm your AI family doctor assistant. I can help review your symptoms and guide you on what level of care may be appropriate. What symptoms are you experiencing today?"
  }
    ],
    encounter: {
      age: null,
      sexAtBirth: null,
      location: null,
      chiefComplaint: null,
      symptomDescription: "",
      redFlags: [],
      triageLevel: null
    }
  };
}

function getSession(sessionId) {
  if (!sessionId) return createSession();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSession());
  }

  return sessions.get(sessionId);
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  const {
    sessionId,
    message,
    age,
    sexAtBirth,
    location
  } = req.body;

  if (!message || !message.trim()) {
    return res.json({ reply: "Please enter a message." });
  }

  try {
    const session = getSession(sessionId);

    // Save/update structured intake fields
    if (age) session.encounter.age = Number(age);
    if (sexAtBirth) session.encounter.sexAtBirth = sexAtBirth;
    if (location) session.encounter.location = location;

    session.encounter.symptomDescription = message;
    if (!session.encounter.chiefComplaint) {
      session.encounter.chiefComplaint = deriveChiefComplaint(message);
    }

    // Controller decides urgency first
    const triage = runTriageController(session.encounter, message);
    session.encounter.redFlags = triage.redFlags;
    session.encounter.triageLevel = triage.triageLevel;

    if (triage.triageLevel === "emergency") {
      return res.json({
        reply: triage.reply,
        triageLevel: triage.triageLevel,
        redFlags: triage.redFlags
      });
    }

    // Push to chat history only after controller pass
    session.messages.push({
      role: "user",
      content: message
    });

    const structuredContext = `
Structured intake:
- Age: ${session.encounter.age ?? "unknown"}
- Sex at birth: ${session.encounter.sexAtBirth ?? "unknown"}
- Location: ${session.encounter.location ?? "unknown"}
- Chief complaint: ${session.encounter.chiefComplaint ?? "unknown"}
- Current controller urgency: ${session.encounter.triageLevel}
- Red flags: ${session.encounter.redFlags.join(", ") || "none"}

Rules for this turn:
- Ask at most 3 targeted follow-up questions if needed.
- Do not diagnose.
- Do not prescribe.
- Do not state final triage as your own decision.
- Be concise.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-nano",
      messages: [
        ...session.messages,
        { role: "developer", content: structuredContext }
      ]
    });

    let reply = completion.choices[0]?.message?.content?.trim();

    if (!reply) {
      reply = "Describe when this started, how severe it is, and whether it is getting worse.";
    }

    session.messages.push({
      role: "assistant",
      content: reply
    });

    res.json({
      reply,
      triageLevel: triage.triageLevel,
      redFlags: triage.redFlags
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      reply: "Something went wrong on the server."
    });
  }
});

// --- Find nearby hospitals ---
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = x => x * Math.PI / 180;
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon/2)**2;

  return 2 * R * Math.asin(Math.sqrt(a));
}


async function overpassFetch(query) {
  const body = new URLSearchParams({ data: query }).toString();

  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const r = await axios.post(url, body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000
      });
      return r.data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
async function osrmTravelTimes(fromLat, fromLon, hospitals) {
  // OSRM wants lon,lat
  const coords = [
    `${fromLon},${fromLat}`,
    ...hospitals.map(h => `${h.lon},${h.lat}`)
  ].join(";");

  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0`;

  const r = await axios.get(url, { timeout: 10000 });
  const durations = r.data?.durations?.[0]; // seconds, index 1..N are destinations
  return durations || null;
}

app.get("/nearby-hospitals", async (req, res) => {
  
  try {
    const mode = String(req.query.mode || "straight"); // "straight" or "travel"
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    // radius in meters (debug-friendly). default 15km, clamp 1–50km
    const radius = Math.min(50000, Math.max(1000, Number(req.query.radius) || 15000));

    console.log("REQ parsed lat/lon/radius:", lat, lon, radius);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({
        error: "Missing/invalid coordinates",
        got: { lat: req.query.lat, lon: req.query.lon }
      });
    }

    const query = `
      [out:json][timeout:10];
      nwr(around:${radius},${lat},${lon})["amenity"="hospital"];
      out center;
    `;

    const json = await overpassFetch(query);

    const hospitals = (json.elements || []).map(el => {
      const c = el.center || { lat: el.lat, lon: el.lon };
      const hLat = Number(c.lat);
      const hLon = Number(c.lon);

      return {
        name: el.tags?.name || "Hospital",
        lat: hLat,
        lon: hLon,
        distance: haversineKm(lat, lon, hLat, hLon)
      };
    })
    .filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lon))
    .sort((a,b) => a.distance - b.distance);

    let results = hospitals.slice(0, 10); // candidates

if (mode === "travel" && results.length > 0) {
  try {
    const durations = await osrmTravelTimes(lat, lon, results);

    if (durations) {
      results = results.map((h, i) => {
        const sec = durations[i + 1]; // destination i is at durations[i+1]
        return {
          ...h,
          travelSeconds: Number.isFinite(sec) ? sec : null,
          travelMinutes: Number.isFinite(sec) ? sec / 60 : null
        };
      });

      results.sort((a, b) => (a.travelSeconds ?? 1e18) - (b.travelSeconds ?? 1e18));
    }
  } catch (e) {
    console.error("OSRM failed, falling back to straight:", e?.message);
  }
}

res.json({
  mode,
  used: {lat, lon, radius},
  top: results[0] || null,
  hospitals: results
});

  } catch (err) {
    console.error("nearby-hospitals error:", err?.response?.status, err?.message);
    res.status(503).json({ error: "Hospital lookup temporarily unavailable. Try again." });
  }
});


app.get("/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const url = "https://nominatim.openstreetmap.org/search";
    const r = await axios.get(url, {
      params: { q, format: "json", limit: 1 },
      headers: { "User-Agent": "ai-family-doctor-app/1.0 (localhost)" }
    });

    const top = r.data?.[0];
    if (!top) return res.json({ found: false });

    res.json({
      found: true,
      lat: Number(top.lat),
      lon: Number(top.lon),
      displayName: top.display_name
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Geocode failed" });
  }
});

// --- Drug searc:contentReference[oaicite:6]{index=6}t) ---
async function rxnormApproximate(term) {
  const url = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json";
  const r = await axios.get(url, {
    params: {
      term,
      maxEntries: 8,
      option: 1 // "Active" concepts (more useful)
    },
    timeout: 12000
  });

  const candidates = r.data?.approximateGroup?.candidate;
  const list = Array.isArray(candidates) ? candidates : (candidates ? [candidates] : []);

  // Keep best ranks first, and only those that actually have an RXCUI
  return list
    .filter(c => c?.rxcui)
    .map(c => ({
      rxcui: String(c.rxcui),
      name: c.name ? String(c.name) : "",
      score: Number(c.score || 0),
      rank: Number(c.rank || 999)
    }))
    .sort((a, b) => (a.rank - b.rank) || (b.score - a.score));
}

async function medlinePlusConnectByRxcui(rxcui, displayName = "") {
  const url = "https://connect.medlineplus.gov/service";

  const r = await axios.get(url, {
    params: {
      "mainSearchCriteria.v.cs": "2.16.840.1.113883.6.88", // RXCUI
      "mainSearchCriteria.v.c": rxcui,
      "mainSearchCriteria.v.dn": displayName || "",
      "informationRecipient.languageCode.c": "en",
      "knowledgeResponseType": "application/json"
    },
    timeout: 12000
  });

  const entries = r.data?.feed?.entry;
  const list = Array.isArray(entries) ? entries : (entries ? [entries] : []);

  return list.map(e => {
    const title =
      e?.title?._value || e?.title || "";

    const links = e?.link;
    const linkList = Array.isArray(links) ? links : (links ? [links] : []);
    const href =
      linkList.find(x => x?.rel === "alternate")?.href ||
      linkList[0]?.href ||
      "";

    const summary = e?.summary?._value || "";

    return { title, url: href, summary };
  }).filter(x => x.title || x.url);
}


app.get("/drug-search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    // 1) RxNorm approximate match -> candidates
    const candidates = await rxnormApproximate(q);

    if (!candidates.length) {
      return res.json({
        query: q,
        match: null,
        results: [],
        sources: [
          { title: "RxNorm API", url: "https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html" }
        ]
      });
    }

    // 2) Pick top candidate
    const top = candidates[0];

    // 3) MedlinePlus Connect lookup by RXCUI
    const results = await medlinePlusConnectByRxcui(top.rxcui, top.name || q);

    return res.json({
  query: q,
  match: top,
  alternatives: candidates.slice(1, 6),
  results,
  sources: results.map(r => ({ title: r.title, url: r.url })), // <-- change
  poweredBy: [
    { title: "MedlinePlus Connect", url: "https://medlineplus.gov/medlineplus-connect/" },
    { title: "RxNorm API", url: "https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html" }
  ]
});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Drug search failed" });
  }
});

app.get("/test-db", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  
  res.json(result.rows);
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
