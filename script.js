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

async function sendMessage() {
  const input = document.getElementById("input");
  const chat = document.getElementById("chat");

  const message = input.value;
  if (!message) return;

  chat.innerHTML += `<div class="user">You: ${message}</div>`;
  input.value = "";

  const response = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });

  const data = await response.json();
  chat.innerHTML += `<div class="bot">Doctor AI: ${data.reply}</div>`;
}
async function uploadImage() {
  const fileInput = document.getElementById("medImage");
  const file = fileInput.files[0];

  const formData = new FormData();
  formData.append("image", file);

  const response = await fetch("http://localhost:3000/scan-med", {
    method: "POST",
    body: formData
  });

  const data = await response.json();
  console.log(data);

  document.getElementById("analysisResult").innerText = data.analysis;
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
    tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
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

    const res = await fetch(`/nearby-hospitals?lat=${lat}&lon=${lon}`);
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
  const manualLat = Number(latStr);
  const manualLon = Number(lonStr);

  if (Number.isFinite(manualLat) && Number.isFinite(manualLon)) {
    await runWithCoords(manualLat, manualLon, "manual coords");
    return;
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

async function showHospitalMap() {
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    // init map once
    if (!map) {
      map = L.map("map").setView([lat, lon], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(map);
      fixLeafletSize();
    } else {
      map.setView([lat, lon], 13);
      fixLeafletSize();
    }

    // user marker
    if (userMarker) userMarker.remove();
    userMarker = L.marker([lat, lon]).addTo(map).bindPopup("You are here").openPopup();

    // fetch nearest hospital from your Node route
    const radius = 15000; // or from an input box
    const res = await fetch(`/nearby-hospitals?lat=${lat}&lon=${lon}&radius=${radius}`);
    const data = await res.json();
    if (!data.top) return;

    const h = data.top;

    // hospital marker
    if (hospitalMarker) hospitalMarker.remove();
    hospitalMarker = L.marker([h.lat, h.lon]).addTo(map)
      .bindPopup(`${h.name}<br>${h.distance.toFixed(1)} km<br>
        <a target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lon}">
          Directions
        </a>`);
    console.log("Hospital:", h);
    // fit view to show both
    const bounds = L.latLngBounds([[lat, lon], [h.lat, h.lon]]);
    map.fitBounds(bounds, { padding: [30, 30] });
    fixLeafletSize();
  }, () => alert("Location permission denied."));
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
  ["input", "symptomQuery", "lat", "lon", "address"].forEach(id => {
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
  showHospitalMap();
};