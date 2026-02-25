// server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { searchMedlinePlus, fetchMedlinePlusSummary } from "./medlineplus.js";

import { auth } from "express-openid-connect";

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

// Load environment variables from .env
dotenv.config();

// Create Express app
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(".")); // serves index.html, script.js, etc.

const config = {
  authRequired: true,
  auth0Logout: true,
  secret: 'a long, randomly-generated string stored in env',
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
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({ dest: "uploads/" });

app.post("/scan-med", upload.single("image"), async (req, res) => {
  try {
    const formData = new FormData();
    formData.append("image", fs.createReadStream(req.file.path));

    const ocrResponse = await axios.post(
      "http://localhost:5001/ocr",
      formData,
      { headers: formData.getHeaders() }
    );

    fs.unlinkSync(req.file.path);

    const rawText = ocrResponse.data.text;

    // ✅ SEND OCR TEXT TO GPT
    const gptResponse = await openai.responses.create({
      model: "gpt-5-mini",
      input: `
    Extract the medication information from this OCR text.
    Return valid JSON with:
    - brand_name
    - generic_name
    - strength
    - dosage_form
    - identifier (DIN or NDC if present)

    OCR TEXT:
    ${rawText}
    `
    });

    console.log("GPT TEXT OUTPUT:", gptResponse.output_text);

    const structuredData = JSON.parse(gptResponse.output_text);
    const analysisResponse = await openai.responses.create({
    model: "gpt-5-mini",
    input: `
    You are a medical assistant.

    Provide a clear, structured medication analysis for the following drug:

    Brand name: ${structuredData.brand_name}
    Generic name: ${structuredData.generic_name}
    Strength: ${structuredData.strength}
    Dosage form: ${structuredData.dosage_form}
    Identifier: ${structuredData.identifier}

    Include:
    1. What it is used for
    2. How it works
    3. How to use it
    4. Common side effects
    5. Serious warnings
    6. When to see a doctor

    Keep it clear and patient-friendly.
    `
    });

    res.json({
  structured: structuredData,
  analysis: analysisResponse.output_text
});


  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OCR failed" });
  }
  
});

function extractDrugInfo(text) {
  const approvalMatch = text.match(/国药准字[HZSJ]\d{8}/);
  const approvalNumber = approvalMatch ? approvalMatch[0] : null;

  const lines = text.split("\n");
  const drugName = lines[0]; // crude MVP method

  return { drugName, approvalNumber };
}

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
    model: "gpt-5-mini",
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

const DOCTOR_CONTRACT = `
You are an AI family doctor in a multi-turn conversation.

STRICT OUTPUT RULES (must follow):
- No apologies or emotional phrases.
- Acknowledgements optional, max 6 words.
- No meta commentary.
- Max 3 follow-up questions.
- Avoid exhaustive checklists unless red flags are present.
- Be concise and clinically focused.

RESPONSE FORMAT (mandatory):
Acknowledgement (optional)

Assessment:
- 1–2 short bullet points only

Next questions:
- 1–3 concise questions
- Omit if none needed

When to seek urgent care:
- Include only if red flags are present

At each turn, perform ONLY ONE of the following:
1) Give a brief assessment OR
2) Ask follow-up questions
Never do both unless explicitly instructed.

If the response violates the format, rewrite it internally before outputting.

`;

// Emergency keyword list
const emergencyKeywords = [
  "chest pain",
  "can't breathe",
  "cannot breathe",
  "shortness of breath",
  "unconscious",
  "stroke",
  "seizure",
  "heart attack",
  "severe bleeding"
];

// ---- Conversation state (single-user MVP) ----
let messages = [
  { role: "developer", content: DOCTOR_CONTRACT }
];

const MAX_ASSISTANT_TURNS = 20;

// Chat endpoint
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  if (!userMessage) {
    return res.json({ reply: "Please enter a message." });
  }

  // Emergency check
  const isEmergency = emergencyKeywords.some(keyword =>
    userMessage.toLowerCase().includes(keyword)
  );

  if (isEmergency) {
    return res.json({
      reply:
        "⚠️ This may be a medical emergency. Please contact emergency services or go to the nearest emergency room immediately."
    });
  }

  try {
    // Add user message to history
    messages.push({
      role: "user",
      content: userMessage
    });

    // Count assistant turns
    const assistantTurns = messages.filter(
      m => m.role === "assistant"
    ).length;

    // Hard cap enforcement
    if (assistantTurns >= MAX_ASSISTANT_TURNS) {
      messages.push({
        role: "developer",
        content: `
The conversation has reached its maximum length.
Provide a concise assessment and clear next steps.
Do NOT ask further questions.
`
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages
    });

    let reply = completion.choices[0]?.message?.content;

    // Fallback
    if (!reply || !reply.trim()) {
      reply = "Could you tell me a bit more about what you’re experiencing?";
    }

    // Add assistant reply to history
    messages.push({
      role: "assistant",
      content: reply
    });

    res.json({ reply });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      reply: "Sorry, something went wrong on the server."
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
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

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

app.get("/nearby-hospitals", async (req, res) => {
  try {
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

    res.json({
      used: { lat, lon, radius },
      count: hospitals.length,
      top: hospitals[0] || null,
      hospitals: hospitals.slice(0, 10) // ✅ return more for debugging
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


// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
