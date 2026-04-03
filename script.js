let activeConversationId = null;

async function loadConversations() {
  const res = await fetch("/api/conversations");
  const conversations = await res.json();

  const list = document.getElementById("conversationList");
  list.innerHTML = "";

  conversations.forEach(c => {
    const row = document.createElement("div");
    row.className = "conversation-row";

    const title = document.createElement("div");
    title.className = "conversation-item";
    title.textContent = c.title || "New consultation";
    title.onclick = () => loadConversation(c.id);

    const actions = document.createElement("div");
    actions.className = "conversation-actions";

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "✎";
    renameBtn.onclick = async (e) => {
      e.stopPropagation();
      await renameConversation(c.id, c.title);
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "🗑";
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      await deleteConversation(c.id);
    };

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(title);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function createConversation() {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "New consultation" })
  });

  const text = await res.text();
  console.log("status:", res.status);
  console.log("raw response:", text);

  const convo = JSON.parse(text);
  activeConversationId = convo.id;

  document.getElementById("chat").innerHTML = "";
  loadConversations();
}

async function loadConversation(id) {
  activeConversationId = id;

  const res = await fetch(`/api/conversations/${id}/messages`);

  if (!res.ok) {
    const text = await res.text();
    console.error("loadConversation failed:", res.status, text);
    throw new Error("Failed to load conversation");
  }

  const messages = await res.json();

  const chat = document.getElementById("chat");
  chat.innerHTML = "";

  messages.forEach(m => {
    appendBubble(m.role === "user" ? "user" : "bot", m.content);
  });
}

async function renameConversation(id, oldTitle) {
  const newTitle = prompt("Rename consultation:", oldTitle || "New consultation");
  if (!newTitle || !newTitle.trim()) return;

  const res = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: newTitle.trim() })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Rename failed:", text);
    return;
  }

  await loadConversations();
}

async function deleteConversation(id) {
  const ok = confirm("Delete this consultation?");
  if (!ok) return;

  const res = await fetch(`/api/conversations/${id}`, {
    method: "DELETE"
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Delete failed:", text);
    return;
  }

  if (activeConversationId === id) {
    activeConversationId = null;
    document.getElementById("chat").innerHTML = "";
  }

  await loadConversations();
}

function showSection(key) {
    // show/hide sections
    document.querySelectorAll('.section').forEach(s => {
        s.style.display = (s.id === 'section-' + key) ? 'block' : 'none';
    });

    // remove active from all buttons
    document.querySelectorAll('.navbar button').forEach(btn => {
        btn.classList.remove('active');
    });

    // find button that opens this section and activate it
    const activeBtn = document.querySelector(`.navbar button[onclick="showSection('${key}')"]`);
    if (activeBtn) activeBtn.classList.add('active');
}

const sessionId =
  localStorage.getItem("sessionId") || crypto.randomUUID();

localStorage.setItem("sessionId", sessionId);

async function checkLogin() {
  const r = await fetch("/api/me");
  const data = await r.json();

  if (data.authenticated) {
    console.log("Logged in as", data.user.name);
  } else {
    console.log("Not logged in");
  }
}

checkLogin();

function showWelcomeMessage() {
  const chat = document.getElementById("chat");

  const div = document.createElement("div");
  div.className = "bot";
  div.textContent =
    "Hello — I'm your AI family doctor assistant. I can help review your symptoms and guide you on what level of care may be appropriate. What symptoms are you experiencing today?";

  chat.appendChild(div);
}

function appendBubble(className, text) {
  const chat = document.getElementById("chat");
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

let isSending = false;

async function sendMessage() {
  if (isSending) return;
  if (!activeConversationId) {
    await createConversation();
  }
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const message = input.value.trim();
  if (!message) return;

  isSending = true;
  input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  // user bubble
  appendBubble("user", message);
  input.value = "";

  // typing bubble
  const typingEl = appendBubble("typing", "Doctor is typing...");

  try {
    const response = await fetch(`/api/chat/${activeConversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        age,
        sexAtBirth,
        location
      })
    });

    const data = await response.json();

    // remove typing bubble
    typingEl.remove();

    // bot bubble
    appendBubble("bot", data.reply || "No response.");
    loadConversations?.();
  } catch (err) {
    console.error(err);
    typingEl.remove();
    appendBubble("bot", "Server error. Please try again.");
  } finally {
    isSending = false;
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

// Enter-to-send
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("input");
  if (!input) return;

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
});

document.addEventListener("DOMContentLoaded", () => {
  setTimeout( showWelcomeMessage, 500);
});

function renderMedicationSuggestions(suggestions) {
  const box = document.getElementById("medNameSuggestions");
  if (!box) return;

  box.innerHTML = "";

  if (!suggestions.length) {
    box.style.display = "none";
    return;
  }

  box.style.display = "block";

  suggestions.forEach(item => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.marginRight = "8px";
    btn.style.marginBottom = "8px";
    btn.textContent = `${item.official_name} (${item.score})`;

    btn.onclick = () => {
      document.getElementById("medBrandName").value = item.official_name || "";
      if (item.generic_name) {
        document.getElementById("medGenericName").value = item.generic_name;
      }
      if (item.dosage_form) {
        document.getElementById("medDosageForm").value = item.dosage_form;
      }
      if (item.route) {
        document.getElementById("medRoute").value = item.route;
      }
      if (item.manufacturer) {
        document.getElementById("medManufacturer").value = item.manufacturer;
      }
    };

    box.appendChild(btn);
  });
}

let lastMedicationScan = null;

async function scanMedication() {
  const fileInput = document.getElementById("medImage");
  const statusEl = document.getElementById("medScanStatus");
  const extractionBox = document.getElementById("medExtractionBox");
  const ocrBox = document.getElementById("medOcrBox");
  const ocrTextEl = document.getElementById("medOcrText");
  const analysisEl = document.getElementById("analysisResult");
  const inputLanguage = document.getElementById("medInputLanguage").value;
  const outputLanguage = document.getElementById("medOutputLanguage").value;
  const scanMode = document.getElementById("medScanMode").value;

  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    alert("Please select at least one image.");
    return;
  }

  statusEl.textContent = "Scanning medication...";
  extractionBox.style.display = "none";
  ocrBox.style.display = "none";
  analysisEl.style.display = "none";
  analysisEl.innerText = "";

  const formData = new FormData();
  files.forEach(file => formData.append("images", file));
  formData.append("inputLanguage", inputLanguage);
  formData.append("outputLanguage", outputLanguage);
  formData.append("scanMode", scanMode);

  try {
    const response = await fetch("/scan-med", {
      method: "POST",
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Medication scan failed");
    }

    lastMedicationScan = data;

    renderMedicationSuggestions(data.nameSuggestions || []);

    document.getElementById("medBrandName").value = data.extracted?.brand_name || "";
    document.getElementById("medGenericName").value = data.extracted?.generic_name || "";
    document.getElementById("medStrength").value = data.extracted?.strength || "";
    document.getElementById("medDosageForm").value = data.extracted?.dosage_form || "";
    document.getElementById("medRoute").value = data.extracted?.route || "";
    document.getElementById("medIdentifier").value = data.extracted?.identifier || "";
    document.getElementById("medManufacturer").value = data.extracted?.manufacturer || "";
    document.getElementById("medVisibleWarnings").value = (data.extracted?.visible_text_warnings || []).join("\n");
    document.getElementById("medConfidenceNotes").value = (data.extracted?.confidence_notes || []).join("\n");

    ocrTextEl.textContent = data.rawText || "";
    extractionBox.style.display = "block";
    ocrBox.style.display = "block";

    statusEl.textContent =
    data.scanMode === "automatic"
      ? `Automatic mode complete. Confidence: ${data.extractionMeta?.confidence || "unknown"}`
      : "Manual mode complete. Please confirm or edit the detected medication info.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  }
}
async function confirmMedication() {
  const statusEl = document.getElementById("medScanStatus");
  const analysisEl = document.getElementById("analysisResult");

  if (!lastMedicationScan) {
    alert("Please scan a medication first.");
    return;
  }

  const payload = {
    rawText: lastMedicationScan.rawText || "",
    outputLanguage: document.getElementById("medOutputLanguage").value,
    confirmed: {
  brand_name: document.getElementById("medBrandName").value.trim(),
  generic_name: document.getElementById("medGenericName").value.trim(),
  strength: document.getElementById("medStrength").value.trim(),
  dosage_form: document.getElementById("medDosageForm").value.trim(),
  route: document.getElementById("medRoute").value.trim(),
  identifier: document.getElementById("medIdentifier").value.trim(),
  manufacturer: document.getElementById("medManufacturer").value.trim(),
  visible_text_warnings: document.getElementById("medVisibleWarnings").value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean),
  confidence_notes: document.getElementById("medConfidenceNotes").value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
}
  };

  statusEl.textContent = "Generating medication summary...";
  analysisEl.style.display = "none";
  analysisEl.innerText = "";

  try {
    const response = await fetch("/confirm-med", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to generate summary");
    }

    analysisEl.innerText = data.analysis || "No summary returned.";
    analysisEl.style.display = "block";
    statusEl.textContent = "Done.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.message;
  }
}
function clearMedicationScan() {
  lastMedicationScan = null;

  document.getElementById("medImage").value = "";
  document.getElementById("medScanStatus").textContent = "";
  document.getElementById("medBrandName").value = "";
  document.getElementById("medGenericName").value = "";
  document.getElementById("medStrength").value = "";
  document.getElementById("medDosageForm").value = "";
  document.getElementById("medIdentifier").value = "";
  document.getElementById("medOcrText").textContent = "";

  document.getElementById("medExtractionBox").style.display = "none";
  document.getElementById("medOcrBox").style.display = "none";
  document.getElementById("analysisResult").style.display = "none";
  document.getElementById("analysisResult").innerText = "";
}

async function scanReport() {
  const file = document.getElementById("reportImage").files[0];
  if (!file) return alert("Select an image first.");

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("/scan-report", { method: "POST", body: formData });
  const data = await res.json();

  document.getElementById("reportResult").innerText = data.analysis || data.error || "No result.";
}

async function searchSymptoms() {
  const q = document.getElementById("symptomQuery").value.trim();
  const status = document.getElementById("symptomStatus");
  const out = document.getElementById("symptomResult");

  if (!q) return;

  status.textContent = "Searching...";
  out.innerHTML = "";

  try {
    const res = await fetch("/search-condition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");

    status.textContent = `Source: ${data.source || ""}`;

    // Build clickable sources
    const sourcesHtml = (data.sources || [])
  .map(s => `<li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a></li>`)
  .join("");

out.innerHTML = `
  <h3>${data.topic || ""}</h3>
  <p>${data.answer || ""}</p>
  <h4>Sources</h4>
  <ul class="sources-list">
    ${sourcesHtml || "<li>No sources available</li>"}
  </ul>
`;

  } catch (err) {
    status.textContent = "Error";
    out.textContent = err.message;
  }
}

let map, userMarker, hospitalMarker;

function ensureMap(lat, lon) {
  if (!map) {
    map = L.map("map").setView([lat, lon], 13);
    const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
    tileLayer.addTo(map);
  } else {
    map.setView([lat, lon], 13);
  }

  // fix flaky rendering when section/layout changes
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 200);
}

async function findHospital() {
  const statusEl = document.getElementById("hospitalResult");

  const runWithCoords = async (lat, lon, sourceLabel) => {
    ensureMap(lat, lon);

    // user "search point" marker
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.circleMarker([lat, lon], { radius: 8 })
      .addTo(map)
      .bindPopup(`Search point (${sourceLabel})`)
      .openPopup();

    statusEl.innerText = `Searching near ${lat.toFixed(5)}, ${lon.toFixed(5)}...`;

    const useStraight = document.getElementById("useStraightLine")?.checked ?? true;
    const mode = useStraight ? "straight" : "travel";

    const res = await fetch(`/nearby-hospitals?lat=${lat}&lon=${lon}&mode=${mode}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.innerText = data.error || `Server error (${res.status})`;
      return;
    }
    if (!data.top) {
      statusEl.innerText = "No hospitals found nearby (try a bigger radius).";
      return;
    }

    const h = data.top;
    const hLat = Number(h.lat);
    const hLon = Number(h.lon);

    if (!Number.isFinite(hLat) || !Number.isFinite(hLon)) {
      statusEl.innerText = "Hospital coords invalid.";
      return;
    }

    // hospital marker
    if (hospitalMarker) map.removeLayer(hospitalMarker);
    hospitalMarker = L.marker([hLat, hLon]).addTo(map).bindPopup(
      `${h.name}<br>${Number(h.distance).toFixed(1)} km<br>
       <a target="_blank" rel="noopener noreferrer"
          href="https://www.google.com/maps/dir/?api=1&destination=${hLat},${hLon}">
         Directions
       </a>`
    );

    hospitalMarker.openPopup();

    // show both points
    map.fitBounds(L.latLngBounds([[lat, lon], [hLat, hLon]]), { padding: [30, 30] });

    const listEl = document.getElementById("hospitalList");
    const hospitals = data.hospitals || [];

    // Clear old markers for hospitals (not user marker)
    if (window.hospitalMarkers) {
      window.hospitalMarkers.forEach(m => map.removeLayer(m));
    }
    window.hospitalMarkers = [];

    // Build list + markers
    listEl.innerHTML = hospitals.length ? `
      <ol>
        ${hospitals.map((hh, idx) => {
          const metric =
            (mode === "travel" && hh.travelMinutes != null)
              ? `${Math.round(hh.travelMinutes)} min`
              : `${Number(hh.distance).toFixed(1)} km`;

          return `<li>
            <a href="#" data-idx="${idx}" class="hospital-link"><b>${hh.name}</b></a> — ${metric}
            (<a target="_blank" rel="noopener noreferrer"
                href="https://www.google.com/maps/dir/?api=1&destination=${hh.lat},${hh.lon}">Directions</a>)
          </li>`;
        }).join("")}
      </ol>
    ` : "<div>No hospitals found.</div>";

    // Drop markers for each hospital
    hospitals.forEach((hh, idx) => {
      const m = L.marker([Number(hh.lat), Number(hh.lon)]).addTo(map)
        .bindPopup(`${idx + 1}. ${hh.name}`);
      window.hospitalMarkers.push(m);
    });

    // Click list item -> zoom to that hospital
    listEl.querySelectorAll(".hospital-link").forEach(a => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const idx = Number(a.dataset.idx);
        const hh = hospitals[idx];
        map.setView([Number(hh.lat), Number(hh.lon)], 15);
        window.hospitalMarkers[idx].openPopup();
      });
    });

    statusEl.innerHTML = `
      <b>Closest hospital:</b><br>
      ${h.name}<br>
      Distance: ${Number(h.distance).toFixed(1)} km<br><br>
      <a target="_blank" rel="noopener noreferrer"
         href="https://www.google.com/maps/dir/?api=1&destination=${hLat},${hLon}">
         Get Directions
      </a>
    `;
  };

  // ✅ 1) Manual lat/lon FIRST (debug-friendly)
  const latStr = document.getElementById("lat")?.value?.trim() || "";
  const lonStr = document.getElementById("lon")?.value?.trim() || "";

  // ✅ IMPORTANT: if either box is empty, do NOT parse to Number ("" -> 0)
  if (latStr !== "" && lonStr !== "") {
    const manualLat = Number(latStr);
    const manualLon = Number(lonStr);

    if (Number.isFinite(manualLat) && Number.isFinite(manualLon)) {
      await runWithCoords(manualLat, manualLon, "manual coords");
      return;
    } else {
      statusEl.innerText = "Invalid lat/lon format.";
      return;
    }
  }

  // ✅ 2) Address SECOND
  const address = document.getElementById("address")?.value?.trim() || "";
  if (address) {
    statusEl.innerText = "Looking up address...";
    const res = await fetch(`/geocode?q=${encodeURIComponent(address)}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.innerText = data.error || `Geocode error (${res.status})`;
      return;
    }
    if (!data.found) {
      statusEl.innerText = "Address not found. Try a more specific address.";
      return;
    }

    await runWithCoords(Number(data.lat), Number(data.lon), "address");
    return;
  }

  // ✅ 3) Geolocation LAST (so manual testing works even if geo is allowed)
  // 3) Geolocation LAST
if (!navigator.geolocation) {
  statusEl.innerText = "Couldn’t get your location. Enter lat/lon or an address.";
  return;
}

navigator.geolocation.getCurrentPosition(
  (pos) => runWithCoords(pos.coords.latitude, pos.coords.longitude, "browser location"),
  () => (statusEl.innerText = "Location denied. Enter lat/lon or an address."),
  { enableHighAccuracy: true, timeout: 8000 }
);
}



function fixLeafletSize() {
  if (!map) return;
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 200);
}


async function searchDrug() {
  const query = document.getElementById("drugSearchInput").value.trim();
  const resultEl = document.getElementById("drugSearchResult");
  if (!query) return;

  resultEl.textContent = "Searching...";

  try {
    const res = await fetch(`/drug-search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");

    const results = data.results || [];
    const sources = data.sources || [];
    const alts = data.alternatives || [];

    const resultsHtml = results.length
      ? `<ul class="sources-list">
          ${results.map(r =>
            `<li><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title || r.url}</a></li>`
          ).join("")}
         </ul>`
      : `<div>No MedlinePlus drug page found for this.</div>`;

    const altsHtml = alts.length
      ? `<details style="margin-top:10px;">
           <summary>Other possible matches</summary>
           <ul>
             ${alts.map(a => `<li>${a.name || a.rxcui}</li>`).join("")}
           </ul>
         </details>`
      : "";

    const sourcesHtml = sources.length
      ? `<h4>Sources</h4>
         <ul class="sources-list">
           ${sources.map(s =>
             `<li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a></li>`
           ).join("")}
         </ul>`
      : "";

    resultEl.innerHTML = `
      <h3>${(data.match?.name || query)}</h3>
      <div style="color:#555; font-size:14px;">
        RXCUI: ${data.match?.rxcui || "N/A"}
      </div>
      <h4>Results</h4>
      ${resultsHtml}
      ${altsHtml}
      ${sourcesHtml}
    `;
  } catch (err) {
    resultEl.textContent = err.message;
  }
}


window.addEventListener("load", () => {
  // your existing default tab
  showSection("private");

  // clear old outputs
  const idsToClear = ["analysisResult", "reportResult", "symptomResult", "hospitalResult", "locStatus"];
  idsToClear.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });

  // clear inputs (optional)
  ["input", "symptomQuery", "lat", "lon", "address","age","sexAtBirth","location"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  // file inputs: you can try clearing (some browsers restrict)
  ["medImage", "reportImage"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
});

window.onload = () => {
  showSection("private");

  // initialize map with a default view (Toronto-ish) so it always renders
  ensureMap(43.6532, -79.3832);

  // optional: clear old output
  const out = document.getElementById("hospitalResult");
  if (out) out.innerHTML = "";
  const list = document.getElementById("hospitalList");
  if (list) list.innerHTML = "";
};

document.getElementById("newChatBtn").onclick = createConversation;

loadConversations();