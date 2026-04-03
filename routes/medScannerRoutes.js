import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";

import {
  getMedCatalog,
  getNameCandidates,
  findBestMedicationMatches,
  extractDrugInfo,
  extractDrugInfoWithAI
} from "../services/medScannerService.js";

export default function medicationScannerRoutes({ openai }) {
  const router = express.Router();
  const upload = multer({ dest: "uploads/" });
  const medCatalog = getMedCatalog();

  router.post("/scan-med", upload.array("images", 5), async (req, res) => {
    const uploadedPaths = [];

    try {
      if (!req.files || !req.files.length) {
        return res.status(400).json({ error: "No image uploaded" });
      }

      const inputLanguage = req.body.inputLanguage === "zh" ? "zh" : "en";
      const outputLanguage = req.body.outputLanguage === "zh" ? "zh" : "en";
      const scanMode = req.body.scanMode === "automatic" ? "automatic" : "manual";

      const allText = [];

      for (const file of req.files) {
        uploadedPaths.push(file.path);

        const formData = new FormData();
        formData.append("image", fs.createReadStream(file.path));
        formData.append("language", inputLanguage);

        const ocrResponse = await axios.post(
          "http://localhost:5001/ocr",
          formData,
          { headers: formData.getHeaders() }
        );

        const text = (ocrResponse.data.text || "").trim();
        if (text) allText.push(text);
      }

      const rawText = allText.join("\n\n--- IMAGE SEPARATOR ---\n\n").trim();

      if (!rawText) {
        return res.status(400).json({
          error:
            inputLanguage === "zh"
              ? "未识别到文字。请确认上传的是清晰中文药盒图片，或切换输入语言。"
              : "No text detected. Make sure the image is clear and the OCR input language is correct."
        });
      }

      let extracted;
      let lines = rawText.split("\n").map(s => s.trim()).filter(Boolean);
      let nameSuggestions = [];
      let extractionMeta = { mode: scanMode, confidence: "unknown" };

      if (scanMode === "automatic") {
        const aiResult = await extractDrugInfoWithAI({ openai, rawText, outputLanguage });

        extracted = aiResult?.extracted || {
          brand_name: "",
          generic_name: "",
          strength: "",
          dosage_form: "",
          route: "",
          identifier: "",
          manufacturer: "",
          visible_text_warnings: [],
          confidence_notes: ["AI extraction failed."]
        };

        nameSuggestions = (aiResult?.nameSuggestions || []).map(item => ({
          official_name: item.official_name || "",
          generic_name: item.generic_name || "",
          dosage_form: item.dosage_form || "",
          route: item.route || "",
          manufacturer: item.manufacturer || "",
          reason: item.reason || ""
        }));

        extractionMeta.confidence = aiResult?.overall_confidence || "unknown";
      } else {
        const manualResult = extractDrugInfo(rawText);
        extracted = manualResult?.extracted || manualResult;
        lines = manualResult?.lines || lines;

        const candidates = getNameCandidates(lines);
        if (extracted.brand_name) candidates.unshift(extracted.brand_name);

        const matches = findBestMedicationMatches(candidates, medCatalog, {
          dosage_form: extracted.dosage_form,
          route: extracted.route
        });

        nameSuggestions = matches.map(m => ({
          official_name: m.entry.official_name,
          generic_name: m.entry.generic_name || "",
          dosage_form: m.entry.dosage_form || "",
          route: m.entry.route || "",
          manufacturer: m.entry.manufacturer || "",
          score: Number(m.score.toFixed(3))
        }));

        extractionMeta.confidence = "rule-based";
      }

      res.json({
        rawText,
        extracted,
        nameSuggestions,
        extractionMeta,
        inputLanguage,
        outputLanguage,
        scanMode,
        message:
          outputLanguage === "zh"
            ? "请确认或修改识别出的药品信息，然后继续。"
            : "Please confirm or edit the detected medication info before continuing."
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Medication scan failed" });
    } finally {
      for (const p of uploadedPaths) {
        try {
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
          console.error("Failed to delete temp file:", p, e);
        }
      }
    }
  });

  router.post("/confirm-med", async (req, res) => {
    try {
      const { rawText = "", confirmed = {}, outputLanguage = "en" } = req.body || {};

      const {
        brand_name = "",
        generic_name = "",
        strength = "",
        dosage_form = "",
        route = "",
        identifier = "",
        manufacturer = "",
        visible_text_warnings = [],
        confidence_notes = []
      } = confirmed;

      const languageInstruction =
        outputLanguage === "zh"
          ? "Write the final answer in Simplified Chinese."
          : "Write the final answer in English.";

      const analysisResponse = await openai.responses.create({
        model: "gpt-5-mini",
        input: `
You are a careful medical assistant.
${languageInstruction}

The user has already reviewed or edited the medication fields below.
Use these confirmed fields as the primary basis.

Confirmed medication info:
- Brand name: ${brand_name || "Unknown"}
- Generic name: ${generic_name || "Unknown"}
- Strength: ${strength || "Unknown"}
- Dosage form: ${dosage_form || "Unknown"}
- Route: ${route || "Unknown"}
- Identifier: ${identifier || "Unknown"}
- Manufacturer: ${manufacturer || "Unknown"}
- Visible text warnings: ${visible_text_warnings.length ? visible_text_warnings.join("; ") : "None"}
- Confidence notes: ${confidence_notes.length ? confidence_notes.join("; ") : "None"}

Raw OCR text from packaging:
${rawText || "None"}

Write a patient-friendly medication summary with these sections:
1. What this medicine is
2. Common uses
3. How to use safely
4. Common side effects
5. Serious warnings
6. When to seek medical care

Rules:
- Be cautious if the medication identity is uncertain.
- Do not invent exact dosing instructions unless clearly supported by the provided data.
- Mention uncertainty if important details are missing.
- Keep it clear and concise.
`
      }, { timeout: 120000 });

      res.json({ analysis: analysisResponse.output_text });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to generate medication summary" });
    }
  });

  return router;
}