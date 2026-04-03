import fs from "fs";
import path from "path";

const RXNAV_BASE = "https://rxnav.nlm.nih.gov/REST";
const OUTPUT_FILE = path.join(process.cwd(), "med_catalog.json");

const seeds = [
  "azithromycin",
  "amoxicillin",
  "ibuprofen",
  "acetaminophen",
  "pimecrolimus",
  "Elidel"
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function guessDosageForm(name = "") {
  const s = name.toLowerCase();
  if (s.includes("tablet")) return "tablet";
  if (s.includes("capsule")) return "capsule";
  if (s.includes("cream")) return "cream";
  if (s.includes("ointment")) return "ointment";
  if (s.includes("gel")) return "gel";
  if (s.includes("spray")) return "spray";
  if (s.includes("solution")) return "solution";
  if (s.includes("suspension")) return "suspension";
  if (s.includes("patch")) return "patch";
  if (s.includes("syrup")) return "syrup";
  if (s.includes("inhaler")) return "inhaler";
  return "";
}

function guessRoute(name = "") {
  const s = name.toLowerCase();
  if (s.includes("oral")) return "oral";
  if (s.includes("topical")) return "topical";
  if (s.includes("ophthalmic")) return "ophthalmic";
  if (s.includes("otic")) return "otic";
  if (s.includes("nasal")) return "nasal";
  if (s.includes("inhalation")) return "inhalation";
  return "";
}

function normalizeAlias(s = "") {
  return s.trim();
}

async function lookupApproximateTerm(term) {
  const url = `${RXNAV_BASE}/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=5`;
  const data = await fetchJson(url);
  return data.approximateGroup?.candidate || [];
}

async function getProperties(rxcui) {
  const url = `${RXNAV_BASE}/rxcui/${encodeURIComponent(rxcui)}/properties.json`;
  const data = await fetchJson(url);
  return data.properties || null;
}

async function getRelatedBrandNames(rxcui) {
  try {
    const url = `${RXNAV_BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=BN`;
    const data = await fetchJson(url);
    const groups = data.relatedGroup?.conceptGroup || [];
    const out = [];
    for (const g of groups) {
      for (const c of g.conceptProperties || []) {
        if (c.name) out.push(c.name);
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function buildEntryFromCandidate(candidate, seed) {
  const rxcui = candidate.rxcui;
  const props = await getProperties(rxcui);
  if (!props?.name) return null;

  const official_name = props.name;
  const aliases = new Set();

  aliases.add(seed);
  aliases.add(official_name);

  const brandNames = await getRelatedBrandNames(rxcui);
  for (const b of brandNames) aliases.add(b);

  return {
    official_name,
    aliases: [...aliases].map(normalizeAlias).filter(Boolean),
    generic_name: "",
    dosage_form: guessDosageForm(official_name),
    route: guessRoute(official_name),
    manufacturer: "",
    identifiers: [],
    rxcui
  };
}

function dedupeEntries(entries) {
  const map = new Map();

  for (const e of entries) {
    if (!e) continue;
    const key = e.rxcui || e.official_name;
    if (!map.has(key)) {
      map.set(key, e);
      continue;
    }

    const existing = map.get(key);
    const aliasSet = new Set([...(existing.aliases || []), ...(e.aliases || [])]);
    existing.aliases = [...aliasSet];
    if (!existing.dosage_form) existing.dosage_form = e.dosage_form;
    if (!existing.route) existing.route = e.route;
  }

  return [...map.values()];
}

async function main() {
  const entries = [];

  for (const seed of seeds) {
    console.log(`Searching: ${seed}`);
    const candidates = await lookupApproximateTerm(seed);

    for (const c of candidates.slice(0, 3)) {
      try {
        const entry = await buildEntryFromCandidate(c, seed);
        if (entry) entries.push(entry);
      } catch (err) {
        console.error(`Failed on ${seed} / ${c.rxcui}:`, err.message);
      }
    }
  }

  const finalEntries = dedupeEntries(entries).sort((a, b) =>
    a.official_name.localeCompare(b.official_name)
  );

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalEntries, null, 2), "utf8");
  console.log(`Wrote ${finalEntries.length} entries to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});