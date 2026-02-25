import { parseStringPromise } from "xml2js";
import * as cheerio from "cheerio";

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "");
}

export async function fetchMedlinePlusSummary(url) {
  const r = await fetch(url);
  if (!r.ok) return "";

  const html = await r.text();
  const $ = cheerio.load(html);

  // Try common MedlinePlus locations
  const candidates = [
    $("#topic-summary").text(),                      // sometimes exists
    $(".topic-summary").text(),                      // sometimes exists
    $("#mplus-content p").first().text(),            // first paragraph in main content
    $("main p").first().text(),                      // generic fallback
    $('meta[name="description"]').attr("content"),   // fallback: meta description
    $('meta[property="og:description"]').attr("content")
  ];

  const best = candidates.map(clean).find(t => t && t.length > 80) || "";
  return best;
}

export async function searchMedlinePlus(term) {
  const url =
    "https://wsearch.nlm.nih.gov/ws/query" +
    `?db=healthTopics&term=${encodeURIComponent(term)}` +
    `&rettype=brief&retmax=5&tool=myaidoc`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`MedlinePlus HTTP ${r.status}`);
  const xml = await r.text();

  console.log("MedlinePlus status:", r.status, r.headers.get("content-type"));
  console.log("MedlinePlus xml head:", xml.slice(0, 300));


  const obj = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
  const docs = obj?.nlmSearchResult?.list?.document;
  const list = Array.isArray(docs) ? docs : (docs ? [docs] : []);

  return list.map(d => {
    const contents = Array.isArray(d.content) ? d.content : (d.content ? [d.content] : []);
    const get = (name) => contents.find(c => c.name === name)?.["_"] ?? "";
    return {
  title: stripHtml(get("title")),
  snippet: stripHtml(get("snippet") || get("fullSummary")),
  url: d.url
};
  });
}

function clean(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

