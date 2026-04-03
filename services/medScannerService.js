import fs from "fs";
import path from "path";

const medCatalog = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "med_catalog.json"), "utf8")
);

export function getMedCatalog() {
  return medCatalog;
}

export function normalizeMedText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s\-_,.，。:：;；"'“”‘’()[\]【】]/g, "")
    .trim();
}

export function bigramSet(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    out.add(s.slice(i, i + 2));
  }
  return out;
}

export function fuzzyScore(a, b) {
  a = normalizeMedText(a);
  b = normalizeMedText(b);

  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;

  const A = bigramSet(a);
  const B = bigramSet(b);

  let overlap = 0;
  for (const x of A) {
    if (B.has(x)) overlap++;
  }

  return overlap / Math.max(A.size, B.size, 1);
}

export function getNameCandidates(lines) {
  const candidates = lines.filter(line =>
    /(片|胶囊|颗粒|口服液|滴眼液|喷雾|软膏|乳膏|糖浆|丸|tablet|capsule|spray|cream|ointment|gel|syrup)/i.test(line)
    || line.length <= 20
  );

  return [...new Set(candidates)].slice(0, 8);
}

export function findBestMedicationMatches(candidates, catalog, context = {}) {
  const scored = [];

  for (const entry of catalog) {
    let best = 0;

    const names = [
      entry.official_name,
      ...(entry.aliases || []),
      entry.generic_name || ""
    ].filter(Boolean);

    for (const candidate of candidates) {
      for (const name of names) {
        best = Math.max(best, fuzzyScore(candidate, name));
      }
    }

    if (context.dosage_form && entry.dosage_form === context.dosage_form) {
      best += 0.08;
    }
    if (context.route && entry.route === context.route) {
      best += 0.05;
    }

    scored.push({ entry, score: best });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

export async function extractDrugInfoWithAI({ openai, rawText, outputLanguage }) {
  const languageInstruction =
    outputLanguage === "zh"
      ? "Return all field values and notes in Simplified Chinese where possible."
      : "Return all field values and notes in English where possible.";

  const response = await openai.responses.create({
    model: "gpt-5-mini",
    input: `
You are extracting medication information from OCR text on a medication package.
${languageInstruction}

Your task:
1. Infer the most likely medication information from the OCR text.
2. Correct likely OCR mistakes cautiously.
3. Do not invent identifiers, strength, manufacturer, or warnings unless supported by visible text.
4. For medication names, you may provide best guesses and alternate candidates.
5. If uncertain, say so clearly.

Return valid JSON only with this shape:
{
  "extracted": {
    "brand_name": "",
    "generic_name": "",
    "strength": "",
    "dosage_form": "",
    "route": "",
    "identifier": "",
    "manufacturer": "",
    "visible_text_warnings": [],
    "confidence_notes": []
  },
  "overall_confidence": "high",
  "nameSuggestions": [
    {
      "official_name": "",
      "generic_name": "",
      "dosage_form": "",
      "route": "",
      "manufacturer": "",
      "reason": ""
    }
  ]
}

Rules:
- "overall_confidence" must be one of: high, medium, low
- "nameSuggestions" should contain up to 3 items
- Keep arrays short
- Return JSON only, no markdown

OCR text:
${rawText}
`
  }, { timeout: 1200000 });

  try {
    return JSON.parse(response.output_text);
  } catch {
    return {
      extracted: {
        brand_name: "",
        generic_name: "",
        strength: "",
        dosage_form: "",
        route: "",
        identifier: "",
        manufacturer: "",
        visible_text_warnings: [],
        confidence_notes: ["AI extraction response could not be parsed."]
      },
      overall_confidence: "low",
      nameSuggestions: []
    };
  }
}

export function extractDrugInfo(text) {
  const cleanText = (text || "").replace(/\r/g, "");
  const lines = cleanText
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const identifierMatch =
    cleanText.match(/国药准字[HZSJZ]\d{8}/) ||
    cleanText.match(/湘药制字[A-Z]?\d{8,}/) ||
    cleanText.match(/\bNDC[:\s-]*\d+(?:-\d+){1,2}\b/i) ||
    cleanText.match(/\bDIN[:\s-]*\d+\b/i) ||
    cleanText.match(/\bNPN[:\s-]*\d+\b/i) ||
    cleanText.match(/\bANDA[:\s-]*\d+\b/i);

  const strengthMatch =
    cleanText.match(/\b\d+(?:\.\d+)?\s*(mg|mcg|μg|g|kg|ml|mL|l|L|%|mg\/ml|mg\/mL|mcg\/ml|g\/100ml|g\/100mL)\b/i) ||
    cleanText.match(/\b\d+(?:\.\d+)?\s*%(?:\s*w\/w|\s*w\/v|\s*v\/v)?\b/i);

  const dosageFormMatch =
    cleanText.match(/\b(tablet|tablets|capsule|capsules|spray|cream|ointment|gel|drops|drop|syrup|patch|inhaler|solution|suspension|lotion|powder|granules|lozenge)\b/i) ||
    cleanText.match(/(片剂|片|胶囊|喷雾剂|喷雾|软膏|乳膏|凝胶|滴剂|糖浆|贴剂|吸入剂|溶液|混悬液|散剂|颗粒|含片)/);

  const routeMatch =
    cleanText.match(/\b(oral|topical|nasal|ophthalmic|otic|throat|sublingual|rectal|vaginal|inhalation|for external use only)\b/i) ||
    cleanText.match(/(口服|外用|鼻用|滴眼|眼用|耳用|咽喉|含服|舌下|吸入用|直肠用|阴道用)/);

  const manufacturerMatch =
    cleanText.match(/(?:manufacturer|manufactured by|made by|distributed by)[:：]?\s*([^\n]+)/i) ||
    cleanText.match(/(?:生产企业|生产厂家|制造商|厂商)[:：]?\s*([^\n]+)/);

  const visible_text_warnings = extractVisibleWarnings(lines);

  const brand_name = guessBrandName(lines);
  const generic_name = guessGenericName(cleanText, lines, brand_name);

  const extracted = {
    brand_name: brand_name || "",
    generic_name: generic_name || "",
    strength: strengthMatch ? strengthMatch[0].trim() : "",
    dosage_form: dosageFormMatch ? dosageFormMatch[0].trim() : "",
    route: routeMatch ? routeMatch[0].trim() : "",
    identifier: identifierMatch ? identifierMatch[0].trim() : "",
    manufacturer: manufacturerMatch ? manufacturerMatch[1].trim() : "",
    visible_text_warnings,
    confidence_notes: []
  };

  extracted.confidence_notes = buildConfidenceNotes(extracted, cleanText, lines);

  return { extracted, lines };
}

function guessBrandName(lines) {
  const filtered = lines.filter(line => {
    if (!line) return false;
    if (line.length < 2) return false;
    if (/^[\W_]+$/.test(line)) return false;
    if (/^(主要成份|功能主治|用法用量|注意事项|有效期|贮藏|规格|批准文号|成份|warnings?|directions?|ingredients?)[:：]?$/i.test(line)) return false;
    if (/^(国药准字|湘药制字|NDC|DIN|NPN)\b/i.test(line)) return false;
    return true;
  });

  return filtered[0] || "";
}

function guessGenericName(cleanText, lines, brandName) {
  const parenMatch = cleanText.match(/[（(]([^（）()]{2,40})[）)]/);
  if (parenMatch) {
    const candidate = parenMatch[1].trim();
    if (candidate && candidate !== brandName) return candidate;
  }

  const englishGenericHints = [
    "acetaminophen", "ibuprofen", "amoxicillin", "cetirizine", "loratadine",
    "omeprazole", "metformin", "diclofenac", "povidone-iodine", "paracetamol"
  ];

  for (const hint of englishGenericHints) {
    if (cleanText.toLowerCase().includes(hint)) return hint;
  }

  const chineseDrugNameLine = lines.find(line =>
    /(片|胶囊|颗粒|口服液|滴眼液|喷雾剂|软膏|乳膏|糖浆)$/.test(line) &&
    line !== brandName
  );

  return chineseDrugNameLine || "";
}

function extractVisibleWarnings(lines) {
  const warningPatterns = [
    /warning/i, /warnings/i, /keep out of reach of children/i, /do not use/i,
    /for external use only/i, /avoid contact with eyes/i, /stop use/i, /ask a doctor/i,
    /警告/, /注意事项/, /禁用/, /慎用/, /忌/, /儿童/, /婴幼儿/, /外用/,
    /本品外观性状改变后应停止使用/, /请咨询医师或药师/
  ];

  const warnings = [];
  for (const line of lines) {
    if (warningPatterns.some(rx => rx.test(line))) warnings.push(line);
  }
  return [...new Set(warnings)].slice(0, 8);
}

function buildConfidenceNotes(extracted, cleanText, lines) {
  const notes = [];
  if (!extracted.brand_name) notes.push("Brand name not confidently detected.");
  if (!extracted.generic_name) notes.push("Generic name not confidently detected.");
  if (!extracted.strength) notes.push("Strength not found in visible text.");
  if (!extracted.dosage_form) notes.push("Dosage form not confidently detected.");
  if (!extracted.route) notes.push("Route was not explicitly found on the package text.");
  if (!extracted.identifier) notes.push("No identifier code was detected.");
  if (!extracted.manufacturer) notes.push("Manufacturer not confidently detected.");
  if (cleanText.length < 40) notes.push("OCR text is very short; extraction may be incomplete.");
  if (lines.length < 3) notes.push("Very few text lines were detected.");
  return notes;
}