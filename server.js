// server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";

// Load environment variables from .env
dotenv.config();

// Create Express app
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(".")); // serves index.html, script.js, etc.

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



// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/*
  GPT-5 mini DOES NOT give you a true system role.
  This is a STRICT conversational contract sent as a developer message.
*/
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

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
