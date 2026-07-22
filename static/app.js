const PALETTE = [
  "#1E4A38", "#C87837", "#2E6688", "#8B3A3A",
  "#5A7A35", "#6B4C8B", "#3A7A70", "#9B5A20",
  "#2A5A7A", "#7A4070", "#4A7A55", "#B84A20", "#5A6A80",
];

const VICTORIA_SLUGS = new Set([
  "victoria", "saanich", "oak-bay", "esquimalt", "langford", "colwood",
  "view-royal", "central-saanich", "north-saanich", "sidney", "sooke",
  "saanich-peninsula", "western-communities", "james-bay", "fairfield",
]);


function victoriaEnabled() {
  return carsConfig?.include_victoria !== false;
}

let chartInstance   = null;
let currentUser    = null;
let cityFilter      = new Set(); // city names; empty = show all
let citySlugByName  = {};        // name → slug for API calls
let lastData        = null;      // { summary, runs, prices, trends }
let lastNearMeData  = null;
let lastTripData    = null;
let stationRequestId = 0;
let lastStationTrendPoints = [];

function applyLimit(items, tableId) {
  const n = parseInt(document.getElementById("limit-" + tableId)?.value ?? "0");
  return n > 0 ? items.slice(0, n) : items;
}

// ── Formatters ───────────────────────────────────────────

function fmtTime(v) {
  if (!v) return "—";
  return new Date(v).toLocaleString("en-CA", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtPrice(v) {
  return v == null ? "—" : Number(v).toFixed(1) + "¢";
}

function fmtDollar(v) {
  return v == null ? "—" : "$" + Number(v).toFixed(2);
}

function fmtFuel(s) {
  const label = s.replace(/_gas$/, "").replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function selectedCitiesLabel() {
  const names = [...cityFilter];
  if (!names.length) return "all cities";
  if (names.length === 1) return names[0];
  return `${names.length} selected cities`;
}

function currentFuel() {
  return document.getElementById("fuelSelect").value;
}

function currentFuelLabel() {
  const select = document.getElementById("fuelSelect");
  return select.options[select.selectedIndex].text;
}

function stationLabel(row) {
  return row.brand || row.name || "Unknown station";
}

function normalizeStationId(value) {
  return value == null ? "" : String(value);
}

function stationKey(row) {
  return normalizeStationId(row.station_id) || `${row.city}|${stationLabel(row)}|${row.address_line1 || ""}`;
}

function selectedSlugs() {
  return [...cityFilter].map(n => citySlugByName[n]).filter(Boolean).join(",");
}

function syncCityFilterUi() {
  document.querySelectorAll(".city-chip").forEach(btn => {
    btn.classList.toggle("active", cityFilter.has(btn.dataset.cityName));
  });
  document.querySelectorAll("#cityRows tr[data-city-name]").forEach(row => {
    row.classList.toggle("selected-row", cityFilter.has(row.dataset.cityName));
  });
  document.getElementById("filterReset")
    .classList.toggle("has-filter", cityFilter.size > 0);
}

function toggleCityFilter(cityName) {
  if (cityFilter.has(cityName)) {
    cityFilter.delete(cityName);
  } else {
    cityFilter.add(cityName);
  }
  syncCityFilterUi();
  renderFiltered();
}

function drawChartMessage(message) {
  const canvas = document.getElementById("trendChart");
  destroyChart();
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#5A6E78";
  ctx.font = "13px 'Inter', sans-serif";
  ctx.fillText(message, 20, 44);
}

async function loadStationTrends() {
  if (!cityFilter.size) return;
  const fuel = currentFuel();
  const hours = document.getElementById("rangeSelect").value;
  const slugs = selectedSlugs();
  const requestId = ++stationRequestId;
  const data = await api(
    `/api/station-trends?city=${encodeURIComponent(slugs)}&fuel=${encodeURIComponent(fuel)}&hours=${hours}`
  );
  const currentFuelValue = currentFuel();
  const currentHours = document.getElementById("rangeSelect").value;
  const currentSlugs = selectedSlugs();
  if (
    requestId !== stationRequestId ||
    fuel !== currentFuelValue ||
    hours !== currentHours ||
    slugs !== currentSlugs
  ) {
    return;
  }
  lastStationTrendPoints = data.points;
  renderStationChart(lastStationTrendPoints);
}

// ── City chip filter ─────────────────────────────────────

function buildCityChips(cities) {
  const bar = document.getElementById("cityChips");
  const visible = victoriaEnabled()
    ? cities
    : cities.filter(c => !VICTORIA_SLUGS.has(c.slug));

  // Rebuild only when the visible set changes
  const key = visible.map(c => c.slug).join(",");
  if (bar.dataset.built === key) return;
  bar.dataset.built = key;
  bar.innerHTML = "";

  // Drop any active filters for now-hidden Victoria cities
  if (!victoriaEnabled()) {
    [...cityFilter].forEach(name => {
      if (VICTORIA_SLUGS.has(citySlugByName[name])) cityFilter.delete(name);
    });
  }

  visible.forEach(c => {
    citySlugByName[c.name] = c.slug;
    const btn = document.createElement("button");
    btn.className = "city-chip" + (cityFilter.has(c.name) ? " active" : "");
    btn.dataset.cityName = c.name;
    btn.textContent = c.name;
    btn.addEventListener("click", () => toggleCityFilter(c.name));
    bar.appendChild(btn);
  });
}

function filterByCity(items, key = "city") {
  let out = items;
  if (!victoriaEnabled()) {
    out = out.filter(i => !VICTORIA_SLUGS.has(citySlugByName[i[key]] ?? i[key]?.toLowerCase().replace(/\s+/g, "-")));
  }
  return cityFilter.size ? out.filter(i => cityFilter.has(i[key])) : out;
}

// ── Renderers ────────────────────────────────────────────

function renderHeader(summary) {
  const scan = summary.last_scan;
  const dot  = document.getElementById("statusDot");
  const txt  = document.getElementById("scanStatus");

  if (scan) {
    dot.className = scan.status === "ok" ? "status-dot ok" : "status-dot err";
    txt.textContent = `Last scan ${fmtTime(scan.started_at)}`;
  } else {
    dot.className = "status-dot";
    txt.textContent = "No scans yet";
  }

  document.getElementById("metrics").innerHTML = [
    metric("Status",        scan ? scan.status.toUpperCase() : "NONE"),
    metric("Cities OK",     scan ? `${scan.cities_ok} / ${scan.cities_requested}` : "0 / 13"),
    metric("Stations Seen", scan ? scan.stations_seen : 0),
    metric("Prices Seen",   scan ? scan.prices_seen   : 0),
  ].join("");
}

function renderCityRows(cities) {
  document.getElementById("cityRows").innerHTML =
    applyLimit(filterByCity(cities, "name"), "cityRows").map(c => `
      <tr class="city-row ${cityFilter.has(c.name) ? "selected-row" : ""}" data-city-name="${escapeHtml(c.name)}">
        <td>${escapeHtml(c.name)}</td>
        <td class="num">${c.station_count || 0}</td>
        <td class="price">${fmtPrice(c.latest_regular_avg)}</td>
        <td class="dim">${fmtTime(c.last_seen_at)}</td>
      </tr>
    `).join("") ||
    `<tr><td colspan="4" class="empty">No city data collected yet.</td></tr>`;
  document.querySelectorAll("#cityRows tr[data-city-name]").forEach(row => {
    row.addEventListener("click", () => toggleCityFilter(row.dataset.cityName));
  });
  syncCityFilterUi();
}

function renderRuns(runs) {
  document.getElementById("runRows").innerHTML =
    applyLimit(runs, "runRows").map(r => `
      <tr>
        <td class="dim">${fmtTime(r.started_at)}</td>
        <td class="${r.status === "ok" ? "ok" : "err"}">${r.status}</td>
        <td class="num">${r.cities_ok} / ${r.cities_requested}</td>
        <td class="num">${r.prices_seen}</td>
      </tr>
    `).join("") ||
    `<tr><td colspan="4" class="empty">No scan runs yet.</td></tr>`;
}

function renderPrices(stations) {
  document.getElementById("pricePanelTitle").textContent =
    cityFilter.size
      ? `Lowest ${currentFuelLabel()} Prices · ${selectedCitiesLabel()}`
      : `Lowest ${currentFuelLabel()} Prices`;

  const visibleStations = applyLimit(filterByCity(stations), "priceRows");
  document.getElementById("priceRows").innerHTML =
    visibleStations.map(r => `
      <tr data-lat="${r.latitude ?? ""}" data-lng="${r.longitude ?? ""}"
          data-name="${escapeHtml(r.brand || r.name)}"
          data-addr="${escapeHtml(r.address_line1 || "")}">
        <td>${escapeHtml(r.city)}</td>
        <td>${escapeHtml(r.brand || r.name)}${r.address_line1
          ? `<span class="dim"> &middot; ${escapeHtml(r.address_line1)}</span>`
          : ""}</td>
        <td class="dim">${fmtFuel(r.fuel_product)}</td>
        <td class="price">${fmtPrice(r.price)}</td>
        <td class="dim">${fmtTime(r.posted_at)}</td>
      </tr>
    `).join("") ||
    `<tr><td colspan="5" class="empty">No station prices collected yet.</td></tr>`;
}

// ── Price map (Lowest Prices toggle) ────────────────────────────────────────
let priceMap = null;
let priceMapMarkers = [];
let priceMapMode = false;

function makePriceBubble(price, isBest) {
  const bg = isBest ? "#0F3D2C" : "#1E2E38";
  const border = isBest ? "#3FE0A3" : "#263A46";
  return L.divIcon({
    className: "",
    html: `<div style="background:${bg};border:1.5px solid ${border};border-radius:4px;padding:2px 5px;color:#fff;font-size:11px;font-weight:700;font-family:Outfit,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4);">${fmtPrice(price)}</div>`,
    iconSize: null,
    iconAnchor: [20, 10],
  });
}

function renderPriceMap(stations) {
  const wrap = document.getElementById("priceMapWrap");
  if (!priceMap) {
    priceMap = L.map("priceMap", { zoomControl: true }).setView([49.25, -122.8], 9);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>",
      maxZoom: 19,
      detectRetina: true,
    }).addTo(priceMap);
  }

  priceMapMarkers.forEach(m => priceMap.removeLayer(m));
  priceMapMarkers = [];

  const fuel = currentFuel();
  const visible = filterByCity(stations).filter(r => r.fuel_product === fuel || !fuel);
  if (!visible.length) return;

  const minPrice = Math.min(...visible.map(r => r.price));
  const bounds = [];
  visible.forEach(r => {
    if (!r.latitude || !r.longitude) return;
    const isBest = r.price === minPrice;
    const marker = L.marker([r.latitude, r.longitude], {
      icon: makePriceBubble(r.price, isBest),
      zIndexOffset: isBest ? 100 : 0,
    })
      .bindTooltip(`${escapeHtml(r.brand || r.name)} · ${escapeHtml(r.city)}`, { direction: "top" })
      .on("click", () => openNavPicker(r.latitude, r.longitude, r.brand || r.name, r.address_line1 || ""))
      .addTo(priceMap);
    priceMapMarkers.push(marker);
    bounds.push([r.latitude, r.longitude]);
  });
  if (bounds.length) priceMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });

  // Invalidate size in case container was hidden during init
  setTimeout(() => priceMap.invalidateSize(), 50);
}

function setPriceView(mapMode) {
  priceMapMode = mapMode;
  document.getElementById("priceTableWrap").style.display = mapMode ? "none" : "";
  document.getElementById("priceMapWrap").style.display = mapMode ? "" : "none";
  document.getElementById("limit-priceRows").style.display = mapMode ? "none" : "";
  const btn = document.getElementById("priceViewToggle");
  btn.classList.toggle("active", mapMode);
  btn.title = mapMode ? "Show table" : "Show map";
  if (mapMode && lastData) renderPriceMap(lastData.prices.stations);
}

function renderStationFocus(stations) {
  const panel = document.getElementById("stationFocus");
  const rowsEl = document.getElementById("stationRows");
  const best = document.getElementById("stationFocusBest");
  const meta = document.getElementById("stationFocusMeta");

  if (!cityFilter.size) {
    panel.hidden = true;
    rowsEl.innerHTML = "";
    best.innerHTML = "";
    return;
  }

  const fuel = currentFuel();
  const rowsByStation = new Map();
  filterByCity(stations)
    .filter(r => r.fuel_product === fuel)
    .forEach(row => {
      const key = stationKey(row);
      const previous = rowsByStation.get(key);
      if (!previous || Number(row.price) < Number(previous.price)) {
        rowsByStation.set(key, row);
      }
    });
  const rows = [...rowsByStation.values()]
    .sort((a, b) => Number(a.price) - Number(b.price));

  panel.hidden = false;
  meta.textContent = `${selectedCitiesLabel()} · ${currentFuelLabel()} · sorted by current price`;

  if (!rows.length) {
    best.innerHTML = "";
    rowsEl.innerHTML = `<tr><td colspan="6" class="empty">No current ${currentFuelLabel().toLowerCase()} prices for this selection.</td></tr>`;
    return;
  }

  const cheapest = rows[0];
  best.innerHTML = `<span>Best</span><strong>${fmtPrice(cheapest.price)}</strong>`;

  rowsEl.innerHTML = applyLimit(rows, "stationRows").map((r, index) => `
    <tr class="${index === 0 ? "best-row" : ""}"
        data-lat="${r.latitude ?? ""}" data-lng="${r.longitude ?? ""}"
        data-name="${escapeHtml(stationLabel(r))}"
        data-addr="${escapeHtml(r.address_line1 || r.city || "")}">
      <td class="rank-col">${index + 1}</td>
      <td class="station-name">${escapeHtml(stationLabel(r))}</td>
      <td class="station-address">${escapeHtml(r.address_line1 || r.city)}</td>
      <td class="payment-type">${escapeHtml(r.payment_type)}</td>
      <td class="station-table-price">${fmtPrice(r.price)}</td>
      <td class="station-posted">${fmtTime(r.posted_at)}</td>
    </tr>
  `).join("");
}

function buildDatasets(items, labelKey, colorKey) {
  // items: flat array of {[labelKey], observed_at, price/avg_price}
  // colorKey: which property to use for stable PALETTE index (e.g. city name)
  const keys   = [...new Set(items.map(i => i[labelKey]))];
  const allKeys = colorKey !== labelKey
    ? [...new Set(items.map(i => i[colorKey]))]
    : keys;

  return keys.map(key => {
    const colorIdx = allKeys.indexOf(items.find(i => i[labelKey] === key)[colorKey]);
    const color    = PALETTE[colorIdx % PALETTE.length];
    const series   = items
      .filter(i => i[labelKey] === key)
      .map(i => ({ x: i.observed_at, y: Number(i.price ?? i.avg_price) }));
    return { key, color, series };
  });
}

function destroyChart() {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
}

function makeChart(canvas, datasets, showLegend, interactionMode = "index") {
  chartInstance = new Chart(canvas, {
    type: "line",
    data: {
      datasets: datasets.map(d => ({
        label:                     d.key,
        data:                      d.series,
        borderColor:               d.color,
        backgroundColor:           d.color + "12",
        borderWidth:               showLegend ? 1.5 : 1,
        pointRadius:               0,
        pointHoverRadius:          4,
        pointHoverBackgroundColor: d.color,
        tension:                   0.3,
        fill:                      false,
      })),
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 300 },
      interaction:         { mode: interactionMode, intersect: false },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat:  "MMM d, HH:mm",
            displayFormats: { hour: "MMM d HH:mm", day: "MMM d" },
          },
          grid:   { color: "#1B2A33" },
          border: { color: "#263A46" },
          ticks:  {
            color: "#5A6E78",
            font:  { family: "'Inter', sans-serif", size: 11 },
            maxTicksLimit: 8,
          },
        },
        y: {
          grid:   { color: "#1B2A33" },
          border: { color: "#263A46" },
          ticks:  {
            color: "#5A6E78",
            font:  { family: "'Inter', sans-serif", size: 11 },
            callback: v => Number(v).toFixed(0) + "¢",
          },
        },
      },
      plugins: {
        legend: showLegend ? {
          position: "bottom",
          labels: {
            color:     "#9FB2BC",
            font:      { family: "'Inter', sans-serif", size: 11 },
            boxWidth:  16,
            boxHeight: 2,
            padding:   16,
          },
        } : { display: false },
        tooltip: {
          backgroundColor: "#1E2E38",
          borderColor:     "#263A46",
          borderWidth:     1,
          titleColor:      "#FFB13C",
          bodyColor:       "#9FB2BC",
          titleFont:       { family: "'Inter', sans-serif", size: 12, weight: "600" },
          bodyFont:        { family: "'Inter', sans-serif", size: 12 },
          padding:         12,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}¢`,
          },
        },
      },
    },
  });
}

function renderCityChart(points) {
  const canvas = document.getElementById("trendChart");
  destroyChart();

  const filtered = victoriaEnabled() ? points : points.filter(p => !VICTORIA_SLUGS.has(p.city_slug));

  if (!filtered.length) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#5A6E78";
    ctx.font = "13px 'Inter', sans-serif";
    ctx.fillText("No trend data collected yet.", 20, 44);
    return;
  }

  const datasets = buildDatasets(filtered, "city", "city");
  document.getElementById("chartTitle").textContent = "Price Trend";
  makeChart(canvas, datasets, true);
}

function renderStationChart(points) {
  const canvas = document.getElementById("trendChart");
  destroyChart();
  const chartPoints = points;

  if (!chartPoints.length) {
    drawChartMessage("No station data for selected cities.");
    return;
  }

  const latestByStation = new Map();
  chartPoints.forEach(point => {
    const stationId = normalizeStationId(point.station_id);
    const previous = latestByStation.get(stationId);
    if (!previous || new Date(point.observed_at) > new Date(previous.observed_at)) {
      latestByStation.set(stationId, point);
    }
  });
  const orderedStationIds = [...latestByStation.values()]
    .sort((a, b) => Number(a.price) - Number(b.price))
    .map(point => normalizeStationId(point.station_id));
  const visiblePoints = chartPoints;
  const cityNames = [...new Set(visiblePoints.map(p => p.city))];
  const datasets  = [];

  cityNames.forEach((city, cityIdx) => {
    const cityPoints = visiblePoints.filter(p => p.city === city);
    const stationIds = [...new Set(cityPoints.map(p => normalizeStationId(p.station_id)))];

    stationIds.forEach((sid, stationIdx) => {
      const sPoints = cityPoints.filter(p => normalizeStationId(p.station_id) === sid);
      const label   = sPoints[0].station + (cityNames.length > 1 ? ` (${city})` : "");
      const colorIdx = orderedStationIds.indexOf(sid);
      datasets.push({
        key:    label,
        color:  PALETTE[colorIdx % PALETTE.length],
        series: sPoints.map(p => ({ x: p.observed_at, y: Number(p.price) })),
      });
    });
  });

  const total = latestByStation.size;
  document.getElementById("chartTitle").textContent = `Station Prices · ${total} stations`;

  makeChart(canvas, datasets, total <= 8, "nearest");
}

// Re-render tables from cache; fetch per-station trend when filter is active.
async function renderFiltered() {
  if (!lastData) return;
  const { summary, prices } = lastData;

  renderCityRows(summary.cities);
  renderStationFocus(prices.stations);
  renderPrices(prices.stations);
  if (priceMapMode) renderPriceMap(prices.stations);

  if (cityFilter.size > 0) {
    try {
      await loadStationTrends();
    } catch (err) {
      console.error("station-trends fetch failed", err);
    }
  } else {
    stationRequestId += 1;
    lastStationTrendPoints = [];
    renderCityChart(lastData.trends.points || []);
  }
}

// ── Data fetch ───────────────────────────────────────────

async function refresh() {
  const fuel  = document.getElementById("fuelSelect").value;
  const hours = document.getElementById("rangeSelect").value;

  const [summary, runs, prices, trends] = await Promise.all([
    api("/api/summary"),
    api("/api/runs"),
    api(`/api/latest?fuel=${encodeURIComponent(fuel)}`),
    api(`/api/trends?fuel=${encodeURIComponent(fuel)}&hours=${hours}`),
  ]);

  lastData = { summary, runs, prices, trends };

  renderHeader(summary);
  buildCityChips(summary.cities);
  renderRuns(runs.runs);
  renderFiltered();
}

// ── Cars & Settings modal ────────────────────────────────

let carsConfig   = null;
let loyaltyPrograms = [];
let homeMap      = null;
let homeMapPin   = null;

async function loadUserConfig() {
  return api("/api/cars");
}

function selectedLoyaltyIds() {
  return carsConfig?.loyalty_programs || [];
}

function carRowHtml(car, idx) {
  return `
    <div class="car-row" data-idx="${idx}">
      <div class="car-fields">
        <label class="field-group">
          <span>Name</span>
          <input class="car-name" type="text" value="${escapeHtml(car.name)}" placeholder="Car name">
        </label>
        <label class="field-group">
          <span>L/100km</span>
          <input class="car-efficiency" type="number" step="0.1" min="1" value="${car.l_per_100km}" placeholder="8.5">
        </label>
        <label class="field-group">
          <span>Tank (L)</span>
          <input class="car-tank" type="number" step="1" min="1" value="${car.tank_litres}" placeholder="50">
        </label>
      </div>
      <button class="delete-car-btn" data-idx="${idx}" aria-label="Remove car">Remove</button>
    </div>
  `;
}

function renderCarsList() {
  const list = document.getElementById("carsList");
  if (!carsConfig || !carsConfig.cars.length) {
    list.innerHTML = `<p class="no-cars">No cars yet — add one below.</p>`;
    return;
  }
  list.innerHTML = carsConfig.cars.map((c, i) => carRowHtml(c, i)).join("");
  
  // Add validation clear listeners
  list.querySelectorAll("input").forEach(input => {
    input.addEventListener("input", () => input.classList.remove("invalid"));
  });

  list.querySelectorAll(".delete-car-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      carsConfig.cars.splice(Number(btn.dataset.idx), 1);
      renderCarsList();
    });
  });
}


function renderLoyaltyGrid(selectedIds = []) {
  const grid = document.getElementById("loyaltyGrid");
  if (!grid) return;
  if (!loyaltyPrograms.length) {
    grid.innerHTML = `<p class="no-cars">No loyalty programs configured.</p>`;
    return;
  }
  const selected = new Set(selectedIds);
  grid.innerHTML = loyaltyPrograms.map(program => `
    <label class="loyalty-chip">
      <input type="checkbox" value="${escapeHtml(program.id)}" ${selected.has(program.id) ? "checked" : ""}>
      <span>${escapeHtml(program.name)}<br><em>${escapeHtml(program.description || `${program.discount_cpl}¢/L`)}</em></span>
    </label>
  `).join("");
}

function loyaltyProgramRowHtml(program, idx) {
  return `
    <div class="loyalty-program-row" data-idx="${idx}">
      <div class="loyalty-program-fields">
        <label class="field-group">
          <span>Name</span>
          <input class="loyalty-name" type="text" value="${escapeHtml(program.name || "")}" placeholder="Program name">
        </label>
        <label class="field-group">
          <span>ID</span>
          <input class="loyalty-id" type="text" value="${escapeHtml(program.id || "")}" placeholder="program_id">
        </label>
        <label class="field-group">
          <span>¢/L</span>
          <input class="loyalty-discount" type="number" step="0.1" min="0" value="${program.discount_cpl ?? 0}" placeholder="3">
        </label>
        <label class="field-group">
          <span>Brands</span>
          <input class="loyalty-brands" type="text" value="${escapeHtml((program.brands || []).join(", "))}" placeholder="shell, chevron">
        </label>
        <label class="field-group loyalty-description-field">
          <span>Description</span>
          <input class="loyalty-description" type="text" value="${escapeHtml(program.description || "")}" placeholder="Shown in settings">
        </label>
        <label class="field-group">
          <span>Weekdays</span>
          <input class="loyalty-weekdays" type="text" value="${escapeHtml((program.weekdays || []).join(","))}" placeholder="0,3">
        </label>
      </div>
      <button class="delete-car-btn delete-loyalty-btn" data-idx="${idx}" aria-label="Remove loyalty program">Remove</button>
    </div>
  `;
}

function renderLoyaltyEditor() {
  const editor = document.getElementById("loyaltyEditor");
  if (!editor) return;
  editor.innerHTML = loyaltyPrograms.map((program, i) => loyaltyProgramRowHtml(program, i)).join("");
  editor.querySelectorAll(".delete-loyalty-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const selectedIds = [...document.querySelectorAll("#loyaltyGrid input:checked")].map(cb => cb.value);
      loyaltyPrograms.splice(Number(btn.dataset.idx), 1);
      renderLoyaltyGrid(selectedIds.filter(id => loyaltyPrograms.some(program => program.id === id)));
      renderLoyaltyEditor();
    });
  });
}

function collectLoyaltyPrograms() {
  return [...document.querySelectorAll("#loyaltyEditor .loyalty-program-row")].map(row => ({
    name: row.querySelector(".loyalty-name").value.trim(),
    id: row.querySelector(".loyalty-id").value.trim(),
    discount_cpl: parseFloat(row.querySelector(".loyalty-discount").value),
    brands: row.querySelector(".loyalty-brands").value.split(",").map(v => v.trim()).filter(Boolean),
    description: row.querySelector(".loyalty-description").value.trim(),
    weekdays: row.querySelector(".loyalty-weekdays").value.split(",").map(v => v.trim()).filter(Boolean),
  }));
}

function collectConfig() {
  const carRows = [...document.querySelectorAll("#carsList .car-row")];
  let hasError = false;

  const cars = carRows.map(row => {
    const nameEl = row.querySelector(".car-name");
    const effEl = row.querySelector(".car-efficiency");
    const tankEl = row.querySelector(".car-tank");

    const name = nameEl.value.trim();
    const eff = parseFloat(effEl.value);
    const tank = parseFloat(tankEl.value);

    // Reset invalid state
    nameEl.classList.remove("invalid");
    effEl.classList.remove("invalid");
    tankEl.classList.remove("invalid");

    if (!name) {
      nameEl.classList.add("invalid");
      hasError = true;
    }
    if (isNaN(eff)) {
      effEl.classList.add("invalid");
      hasError = true;
    }
    if (isNaN(tank)) {
      tankEl.classList.add("invalid");
      hasError = true;
    }

    return { name, l_per_100km: eff, tank_litres: tank };
  });

  if (hasError) return null;

  const loyalty_programs = [...document.querySelectorAll("#loyaltyGrid input:checked")]
    .map(cb => cb.value);
  return {
    home: {
      label: document.getElementById("homeLabel").value.trim() || "Home",
      lat:   parseFloat(document.getElementById("homeLat").value),
      lng:   parseFloat(document.getElementById("homeLng").value),
    },
    fuel:             document.getElementById("defaultFuel").value,
    include_victoria: document.getElementById("includeVictoria").checked,
    loyalty_programs,
    cars,
  };
}

function placeHomePin(lat, lng) {
  document.getElementById("homeLat").value = lat;
  document.getElementById("homeLng").value = lng;
  if (homeMapPin) {
    homeMapPin.setLatLng([lat, lng]);
  } else {
    homeMapPin = L.marker([lat, lng], { icon: makePinIcon("#FFB13C", "H") }).addTo(homeMap);
  }
}

async function openSettings() {
  const modal = document.getElementById("settingsModal");
  modal.hidden = false;
  document.getElementById("settingsSaveMsg").textContent = "";
  try {
    if (!currentUser) {
      currentUser = await api("/api/user").catch(() => ({ role: "user" }));
    }

    const isAdmin = currentUser.role === "admin";
    const requests = [loadUserConfig()];
    if (isAdmin) {
      requests.push(api("/api/loyalty-programs"));
    }

    const [carsData, loyaltyData] = await Promise.all(requests);
    carsConfig = carsData;
    
    if (isAdmin) {
      loyaltyPrograms = loyaltyData.programs || [];
    } else {
      loyaltyPrograms = carsConfig.available_loyalty_programs || [];
    }

    // Hide/show admin-only loyalty editor
    const editorSection = document.getElementById("loyaltyEditorSection");
    if (editorSection) editorSection.hidden = !isAdmin;

    const lat = carsConfig.home?.lat || 49.2827;
    const lng = carsConfig.home?.lng || -123.1207;
    document.getElementById("homeLabel").value = carsConfig.home?.label || "";
    document.getElementById("homeLat").value   = lat;
    document.getElementById("homeLng").value   = lng;
    document.getElementById("defaultFuel").value = carsConfig.fuel || "regular_gas";
    document.getElementById("includeVictoria").checked = carsConfig.include_victoria !== false;
    const savedLoyalty = carsConfig.loyalty_programs || [];
    renderLoyaltyGrid(savedLoyalty);
    if (isAdmin) renderLoyaltyEditor();
    renderCarsList();

    // Init home map (lazy — Leaflet needs the element visible first)
    setTimeout(() => {
      if (!homeMap) {
        homeMap = L.map("homeMap").setView([lat, lng], 12);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
          attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>",
          maxZoom: 19,
        }).addTo(homeMap);
        homeMap.on("click", e => placeHomePin(e.latlng.lat, e.latlng.lng));
      } else {
        homeMap.invalidateSize();
        homeMap.setView([lat, lng], 12);
      }
      placeHomePin(lat, lng);
    }, 80);
  } catch (err) {
    console.error("Failed to load settings", err);
    document.getElementById("settingsSaveMsg").textContent = "Failed to load settings";
    document.getElementById("settingsSaveMsg").className = "save-msg error";
  }
}

function closeSettings() {
  document.getElementById("settingsModal").hidden = true;
}

document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("settingsClose").addEventListener("click", closeSettings);
document.getElementById("settingsModal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeSettings();
});

document.getElementById("addCarBtn").addEventListener("click", () => {
  if (!carsConfig) return;
  carsConfig.cars.push({ name: "", l_per_100km: "", tank_litres: "" });
  renderCarsList();
  document.querySelector("#carsList .car-row:last-child .car-name")?.focus();
});

document.getElementById("addLoyaltyBtn").addEventListener("click", () => {
  const selectedIds = [...document.querySelectorAll("#loyaltyGrid input:checked")].map(cb => cb.value);
  loyaltyPrograms.push({ name: "", id: "", discount_cpl: 0, brands: [], description: "", weekdays: [] });
  renderLoyaltyGrid(selectedIds);
  renderLoyaltyEditor();
  document.querySelector("#loyaltyEditor .loyalty-program-row:last-child .loyalty-name")?.focus();
});

document.getElementById("saveSettings").addEventListener("click", async () => {
  const cfg = collectConfig();
  const msg = document.getElementById("settingsSaveMsg");
  msg.textContent = "";
  msg.className = "save-msg";

  if (!cfg) {
    msg.textContent = "Please fill in all car fields.";
    msg.className = "save-msg error";
    return;
  }

  try {
    const isAdmin = currentUser && currentUser.role === "admin";
    if (isAdmin) {
      const programs = collectLoyaltyPrograms();
      const loyaltyResponse = await fetch("/api/loyalty-programs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ programs }),
      });
      if (!loyaltyResponse.ok) {
        const err = await loyaltyResponse.json();
        msg.textContent = "Error: " + (err.error || "unknown");
        msg.className = "save-msg error";
        return;
      }
      loyaltyPrograms = programs;
    }

    const r = await fetch("/api/cars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!r.ok) {
      const err = await r.json();
      msg.textContent = "Error: " + (err.error || "unknown");
      msg.className = "save-msg error";
      return;
    }
    msg.textContent = "Saved!";
    msg.className = "save-msg ok";
    carsConfig = cfg;
    renderLoyaltyGrid(cfg.loyalty_programs || []);
    renderLoyaltyEditor();
    populateTripCarSelector(cfg.cars);
    refresh();
  } catch (err) {
    msg.textContent = "Save failed";
    msg.className = "save-msg error";
  }
});

// ── Near Me ──────────────────────────────────────────────

function renderNearMe(data) {
  lastNearMeData = data;
  const panel = document.getElementById("nearMe");
  const tbody = document.getElementById("nearMeRows");
  const best  = document.getElementById("nearMeBest");
  const meta  = document.getElementById("nearMeMeta");

  const stations = victoriaEnabled()
    ? data.stations
    : data.stations.filter(s => !VICTORIA_SLUGS.has(
        citySlugByName[s.locality] ?? s.locality?.toLowerCase().replace(/\s+/g, "-")
      ));

  panel.hidden = false;
  meta.textContent = `Within ${data.radius_km} km · ${currentTripFuelLabel()}`;

  if (!stations.length) {
    best.innerHTML = "";
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No stations with recent prices found within ${data.radius_km} km.</td></tr>`;
    return;
  }

  const cheapest = stations[0];
  best.innerHTML = `<span>Best</span><strong>${fmtPrice(cheapest.effective_cpl)}</strong>`;

  tbody.innerHTML = applyLimit(stations, "nearMeRows").map((r, i) => {
    const disc = r.loyalty_discount_cpl || 0;
    const loyaltyBadge = disc > 0 ? `<span class="loyalty-tag">−${disc}¢</span>` : "";
    const outOfRange = !!r.out_of_range;
    const rowClass = [
      i === 0 && !outOfRange ? "best-row" : "",
      outOfRange ? "out-of-range" : "",
    ].filter(Boolean).join(" ");
    const effectivePrice = r.effective_cpl != null ? r.effective_cpl : r.price - disc;
    return `
    <tr class="${rowClass}"
        data-lat="${r.latitude}" data-lng="${r.longitude}"
        data-name="${escapeHtml(r.brand || r.name)}"
        data-addr="${escapeHtml(r.address_line1 || r.locality || "")}">
      <td class="rank-col">${i + 1}${outOfRange ? ' <span class="range-warn" title="May be out of range">⚠</span>' : ""}</td>
      <td>${escapeHtml(r.brand || r.name)}${loyaltyBadge}</td>
      <td class="station-address">${escapeHtml(r.address_line1 || r.locality || "")}</td>
      <td class="station-table-price">${fmtPrice(r.price)}${effectivePrice !== r.price ? `<br><span class="loyalty-tag">→ ${fmtPrice(effectivePrice)}</span>` : ""}</td>
      <td class="num">${r.distance_km} km</td>
      <td class="station-posted">${fmtTime(r.posted_at)}</td>
    </tr>`;
  }).join("");
}

async function findNearMe() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  const btn = document.getElementById("nearMeBtn");
  btn.textContent = "Locating…";
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude, longitude } = pos.coords;
      setTripDest(latitude, longitude, "You are here");
      const fuel = currentTripFuel();
      const plan = currentTripFuelPlan();
      const params = new URLSearchParams({
        lat: latitude,
        lng: longitude,
        fuel,
        loyalty: selectedLoyaltyIds().join(","),
        ...(plan && {
          l_per_100km: plan.lPer100km,
          fill_litres: plan.fillLitres,
          ...(plan.remainingKm != null && { remaining_km: plan.remainingKm }),
        }),
      });
      try {
        const data = await api(`/api/nearby?${params}`);
        renderNearMe(data);
      } catch (err) {
        console.error("nearby fetch failed", err);
        alert("Could not load nearby prices. Check the console for details.");
      } finally {
        btn.textContent = "Near Me";
        btn.disabled = false;
      }
    },
    err => {
      alert("Could not get your location: " + err.message);
      btn.textContent = "Near Me";
      btn.disabled = false;
    },
    { timeout: 10000, maximumAge: 60000 }
  );
}

document.getElementById("nearMeBtn").addEventListener("click", findNearMe);

// ── Trip Calculator ──────────────────────────────────────

let tripMap        = null;
let tripDestMarker = null;
let tripHomeMarker = null;
let tripDestCoords = null;
let tripHomeCoords = null;   // selected starting point
let tripHomeConfig = null;   // configured home from user settings
let tripClickTarget = "dest";
let tripAutoCalcTimer = null;
let tripStationLayers = [];
let tripRouteLayer    = null;
let tripCalcRequestId = 0;
let tripRouteRequestId = 0;
let tripCalcInFlight = false;

const STATION_COLORS = ["#1E4A38", "#2D7A55", "#3D9970", "#5EB388", "#8BCFAB",
                        "#A8D8BC", "#C5E8D4", "#5A6E78"];

function makePinIcon(color, label) {
  return L.divIcon({
    className: "",
    html: `<div style="
      background:${color};border:2px solid #fff;border-radius:50% 50% 50% 0;
      width:22px;height:22px;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.3);
      display:flex;align-items:center;justify-content:center;">
      <span style="transform:rotate(45deg);color:#fff;font-size:10px;font-weight:700;font-family:Outfit,sans-serif;">${escapeHtml(label)}</span>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
    popupAnchor: [0, -24],
  });
}

function populateTripCarSelector(cars) {
  const sel = document.getElementById("tripCarSelect");
  if (cars && cars.length) {
    const prev = sel.value;
    sel.innerHTML = cars.map((c, i) =>
      `<option value="${i}" data-eff="${c.l_per_100km}" data-tank="${c.tank_litres}">${escapeHtml(c.name)}</option>`
    ).join("");
    sel.value = prev && prev < cars.length ? prev : "0";
    updateRangeHint();
  } else {
    sel.innerHTML = `<option value="">— no cars configured —</option>`;
  }
}

function updateRangeHint() {
  const hint = document.getElementById("tripRangeHint");
  const input = document.getElementById("tripTankPct");
  if (!hint || !input) return;
  const opt = document.getElementById("tripCarSelect")?.selectedOptions[0];
  const tankLitres = parseFloat(opt?.dataset.tank);
  const lPer100km  = parseFloat(opt?.dataset.eff);
  const tankPct    = parseFloat(input.value);
  const validTankPct = Number.isFinite(tankPct) && tankPct >= 0 && tankPct < 100;
  input.setCustomValidity(validTankPct ? "" : "Enter a tank level from 0 to 99%.");
  if (!Number.isFinite(tankLitres) || tankLitres <= 0 || !Number.isFinite(lPer100km) || lPer100km <= 0 || !validTankPct) {
    hint.textContent = "";
    updateTripCalcButton();
    return;
  }
  const remainingKm = (tankLitres * tankPct / 100) / lPer100km * 100;
  hint.textContent = "~" + Math.round(remainingKm) + " km remaining";
  updateTripCalcButton();
}

function currentTripFuel() {
  return document.getElementById("tripFuelSelect")?.value || currentFuel();
}

function currentTripFuelLabel() {
  const select = document.getElementById("tripFuelSelect");
  if (!select) return currentFuelLabel();
  return select.options[select.selectedIndex]?.text || currentFuelLabel();
}

function currentTripFuelPlan() {
  const opt = document.getElementById("tripCarSelect")?.selectedOptions[0];
  const lPer100km = parseFloat(opt?.dataset.eff);
  const tankLitres = parseFloat(opt?.dataset.tank);
  const tankPct = parseFloat(document.getElementById("tripTankPct")?.value);
  if (!opt || document.getElementById("tripCarSelect")?.value === ""
      || !Number.isFinite(lPer100km) || lPer100km <= 0
      || !Number.isFinite(tankLitres) || tankLitres <= 0
      || !Number.isFinite(tankPct) || tankPct < 0 || tankPct >= 100) {
    return null;
  }
  const fillLitres = tankLitres * (1 - tankPct / 100);
  const remainingKm = (tankLitres * tankPct / 100) / lPer100km * 100;
  return { lPer100km, tankLitres, tankPct, fillLitres, remainingKm };
}

function invalidateTripCalculation({ clearRoute = false } = {}) {
  tripCalcRequestId += 1;
  tripRouteRequestId += 1;
  tripCalcInFlight = false;
  const btn = document.getElementById("tripCalcBtn");
  if (btn) btn.textContent = "Find cheapest station";
  if (clearRoute && tripRouteLayer && tripMap) {
    tripMap.removeLayer(tripRouteLayer);
    tripRouteLayer = null;
  }
}

async function initTripMap() {
  let cfg;
  try { cfg = await loadUserConfig(); } catch { return; }
  carsConfig = cfg;

  const { lat, lng, label } = cfg.home || {};
  tripHomeConfig = Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng, label: label || "Home" }
    : null;

  // Populate car selector
  populateTripCarSelector(cfg.cars);

  // Set default fuel from config
  if (cfg.fuel) document.getElementById("tripFuelSelect").value = cfg.fuel;

  // Init map
  const mapLat = lat || 49.25;
  const mapLng = lng || -122.8;
  if (tripMap) return;

  tripMap = L.map("tripMap", { zoomControl: true }).setView([mapLat, mapLng], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>",
    maxZoom: 19,
    detectRetina: true,
  }).addTo(tripMap);

  tripMap.on("click", e => {
    const target = tripClickTarget === "start" ? "start" : "dest";
    setTripEndpoint(target, e.latlng.lat, e.latlng.lng, target === "start" ? "Start" : "Destination");
    const source = document.getElementById(target === "start" ? "tripStartSource" : "tripDestSource");
    if (source) source.value = "map";
    if (target === "start" && document.getElementById("tripDestSource")?.value === "map") {
      setTripClickTarget("dest");
    } else {
      updateTripMapHint();
    }
    scheduleTripAutoCalc();
  });

  applyTripSource("start", document.getElementById("tripStartSource")?.value || "home", { autoCalc: false });
  applyTripSource("dest", document.getElementById("tripDestSource")?.value || "map", { autoCalc: false });
}

function setTripEndpoint(target, lat, lng, label) {
  if (target === "start") {
    setTripHome(lat, lng, label);
  } else {
    setTripDest(lat, lng, label);
  }
}

function setTripDest(lat, lng, label) {
  invalidateTripCalculation({ clearRoute: true });
  tripDestCoords = { lat, lng };
  const ll = [lat, lng];
  if (tripDestMarker) {
    tripDestMarker.setLatLng(ll);
    tripDestMarker.setTooltipContent(label || "Destination");
  } else if (tripMap) {
    tripDestMarker = L.marker(ll, { icon: makePinIcon("#FF6B6B", "D"), zIndexOffset: 900 })
      .addTo(tripMap)
      .bindTooltip(label || "Destination", { permanent: false });
  }
  updateTripMapHint();
  updateTripCalcButton();
}

function setTripHome(lat, lng, label) {
  invalidateTripCalculation({ clearRoute: true });
  tripHomeCoords = { lat, lng };
  if (tripHomeMarker) {
    tripHomeMarker.setLatLng([lat, lng]);
    tripHomeMarker.setTooltipContent(label || "Start");
  } else if (tripMap) {
    tripHomeMarker = L.marker([lat, lng], { icon: makePinIcon("#FFB13C", "H"), zIndexOffset: 1000 })
      .addTo(tripMap)
      .bindTooltip(label || "Start", { permanent: false });
  }
  if (tripMap) tripMap.panTo([lat, lng]);
  updateTripMapHint();
  updateTripCalcButton();
}

function clearTripEndpoint(target) {
  invalidateTripCalculation({ clearRoute: true });
  if (target === "start") {
    tripHomeCoords = null;
    if (tripHomeMarker && tripMap) {
      tripMap.removeLayer(tripHomeMarker);
      tripHomeMarker = null;
    }
  } else {
    tripDestCoords = null;
    if (tripDestMarker && tripMap) {
      tripMap.removeLayer(tripDestMarker);
      tripDestMarker = null;
    }
  }
  updateTripMapHint();
  updateTripCalcButton();
}

function updateTripCalcButton() {
  const btn = document.getElementById("tripCalcBtn");
  if (btn) btn.disabled = tripCalcInFlight || !(tripHomeCoords && tripDestCoords && currentTripFuelPlan());
}

function updateTripMapHint() {
  const hint = document.getElementById("tripMapHint");
  const hintText = document.getElementById("tripMapHintText");
  if (!hint || !hintText) return;

  const startNeedsMap = document.getElementById("tripStartSource")?.value === "map" && !tripHomeCoords;
  const destNeedsMap = document.getElementById("tripDestSource")?.value === "map" && !tripDestCoords;
  const activeTarget = startNeedsMap ? "start" : destNeedsMap ? "dest" : tripClickTarget;
  tripClickTarget = activeTarget === "start" ? "start" : "dest";

  if (activeTarget === "start" && document.getElementById("tripStartSource")?.value === "map") {
    hintText.textContent = "Click the map to set your starting point";
    hint.hidden = false;
  } else if (activeTarget === "dest" && document.getElementById("tripDestSource")?.value === "map") {
    hintText.textContent = "Click anywhere on the map to set your destination";
    hint.hidden = !!tripDestCoords;
  } else {
    hint.hidden = true;
  }
}

function setTripClickTarget(target) {
  tripClickTarget = target;
  updateTripMapHint();
}

function scheduleTripAutoCalc() {
  clearTimeout(tripAutoCalcTimer);
  tripAutoCalcTimer = setTimeout(() => {
    if (tripHomeCoords && tripDestCoords && document.getElementById("tripCarSelect")?.value !== "") {
      runTripCalc();
    }
  }, 800);
}

function applyTripSource(target, source, options = {}) {
  const { autoCalc = true } = options;
  const select = document.getElementById(target === "start" ? "tripStartSource" : "tripDestSource");
  if (select && select.value !== source) select.value = source;

  if (source === "home") {
    if (!tripHomeConfig) {
      if (select) select.value = "map";
      clearTripEndpoint(target);
      setTripClickTarget(target);
      return;
    }
    setTripEndpoint(target, tripHomeConfig.lat, tripHomeConfig.lng, target === "start" ? tripHomeConfig.label : "Home");
  } else if (source === "gps") {
    acquireTripGps(target);
    return;
  } else {
    clearTripEndpoint(target);
    setTripClickTarget(target);
  }

  if (autoCalc) scheduleTripAutoCalc();
}

function acquireTripGps(target) {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    const select = document.getElementById(target === "start" ? "tripStartSource" : "tripDestSource");
    if (select) select.value = "map";
    setTripClickTarget(target);
    return;
  }

  const select = document.getElementById(target === "start" ? "tripStartSource" : "tripDestSource");
  if (select) select.disabled = true;
  navigator.geolocation.getCurrentPosition(
    pos => {
      setTripEndpoint(target, pos.coords.latitude, pos.coords.longitude, target === "start" ? "You are here" : "GPS destination");
      if (select) select.disabled = false;
      scheduleTripAutoCalc();
    },
    err => {
      alert("Could not get location: " + err.message);
      if (select) {
        select.disabled = false;
        select.value = "map";
      }
      setTripClickTarget(target);
    },
    { timeout: 10000, maximumAge: 60000 }
  );
}

async function runTripCalc() {
  if (!tripHomeCoords || !tripDestCoords) return;
  if (tripRouteLayer) { tripMap.removeLayer(tripRouteLayer); tripRouteLayer = null; }

  const sel = document.getElementById("tripCarSelect");
  const opt = sel.selectedOptions[0];
  const lPer100km = parseFloat(opt?.dataset.eff);
  if (!opt || sel.value === "" || isNaN(lPer100km)) return;

  const plan = currentTripFuelPlan();
  if (!plan) return;

  const btn = document.getElementById("tripCalcBtn");
  const requestId = ++tripCalcRequestId;
  tripCalcInFlight = true;
  btn.textContent = "Calculating…";
  btn.disabled = true;

  const fillLitres = plan.fillLitres;
  const remainingKm = plan.remainingKm;
  const fuel = currentTripFuel();
  const maxAge = 4;
  const home = tripHomeCoords || {};

  try {
    const params = new URLSearchParams({
      dest_lat:    dest.lat,
      dest_lng:    dest.lng,
      l_per_100km: lPer100km,   // now a parsed number, not a raw string
      fill_litres: fillLitres,
      fuel,
      max_age:     maxAge,
      loyalty:     selectedLoyaltyIds().join(","),
      ...(remainingKm != null && { remaining_km: remainingKm }),
      ...(home.lat && { home_lat: home.lat, home_lng: home.lng }),
    });
    const data = await api(`/api/trip?${params}`);
    data.remainingKm = remainingKm;
    data.fillLitres  = fillLitres;
    renderTripResults(data);
  } catch (err) {
    console.error("trip calc failed", err);
    document.getElementById("tripResultMeta").textContent = "Could not load results — check your connection and try again.";
    document.getElementById("tripResults").hidden = false;
  } finally {
    btn.textContent = "Find cheapest station";
    btn.disabled = false;
  }
}

function renderTripResults(data) {
  lastTripData = data;
  // Clear old station markers
  tripStationLayers.forEach(l => tripMap.removeLayer(l));
  tripStationLayers = [];

  const panel  = document.getElementById("tripResults");
  const tbody  = document.getElementById("tripResultRows");
  const bestEl = document.getElementById("tripResultBest");
  const meta   = document.getElementById("tripResultMeta");

  const stations = victoriaEnabled()
    ? data.stations
    : data.stations.filter(s => !VICTORIA_SLUGS.has(
        citySlugByName[s.locality] ?? s.locality?.toLowerCase().replace(/\s+/g, "-")
      ));

  panel.hidden = false;
  const staleNote = data.station_count === 0
    ? ` · ⚠ no prices within ${data.max_age_hours}h — try a longer age filter`
    : stations.length < 5
    ? ` · ⚠ only ${stations.length} fresh station${stations.length > 1 ? "s" : ""} (prices ≤${data.max_age_hours}h old)`
    : "";
  meta.textContent = `${data.direct_km} km direct · ${fmtFuel(data.fuel)} · credit card · prices ≤${data.max_age_hours}h old${staleNote}`;

  if (!stations.length) {
    bestEl.innerHTML = "";
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No fresh prices found — try increasing the price age filter.</td></tr>`;

    return;
  }

  bestEl.innerHTML = `<span>Best</span><strong>${fmtPrice(stations[0].effective_cpl)}</strong>`;

  const remainingKm = data.remainingKm;
  const banner = document.getElementById("tripRangeBanner");
  if (remainingKm != null && data.direct_km > remainingKm) {
    banner.hidden = false;
    banner.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1L13 12H1L7 1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="5" x2="7" y2="8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="10.5" r="0.7" fill="currentColor"/></svg>
      Your current tank (~${Math.round(remainingKm)} km est.) may not reach the destination (~${Math.round(data.direct_km)} km by road). Fill up en route.`;
  } else {
    banner.hidden = true;
  }

  tbody.innerHTML = applyLimit(stations, "tripResultRows").map((r, i) => {
    const outOfRange = !!r.out_of_range || false;
    const disc = r.loyalty_discount_cpl || 0;
    const loyaltyBadge = disc > 0 ? `<span class="loyalty-tag">−${disc}¢</span>` : "";
    const effectivePrice = r.effective_cpl != null ? r.effective_cpl : r.price - disc;
    const pumpCost = data.fillLitres != null ? fmtDollar(data.fillLitres * r.price / 100) : "—";
    const rowClass = [
      i === 0 && !outOfRange ? "best-row" : "",
      outOfRange ? "out-of-range" : "",
    ].filter(Boolean).join(" ");
    return `
    <tr class="${rowClass}"
        data-lat="${r.latitude}" data-lng="${r.longitude}"
        data-name="${escapeHtml(r.brand || r.name)}"
        data-addr="${escapeHtml(r.address_line1 || r.locality || "")}">
      <td class="rank-col">${i + 1}${outOfRange ? ' <span class="range-warn" title="May be out of range">⚠</span>' : ""}</td>
      <td>${escapeHtml(r.brand || r.name)}${loyaltyBadge}</td>
      <td class="station-address">${escapeHtml(r.address_line1 || r.locality || "")}</td>
      <td class="station-table-price trip-pump-price">
        ${fmtPrice(r.price)}
        ${disc > 0 ? `<br><span class="loyalty-tag trip-loyalty-tag">−${disc}¢</span>` : ""}
        ${effectivePrice !== r.price ? `<br><span class="loyalty-tag">→ ${fmtPrice(effectivePrice)}</span>` : ""}
      </td>
      <td class="num dim" style="font-size:12px;white-space:nowrap">${r.detour_km} km</td>
      <td class="station-table-price trip-eff-price">${fmtPrice(r.effective_cpl)}</td>
      <td class="num">
        <div class="trip-cost-cell">
          <span class="trip-pump-cost">${pumpCost}</span>
          <span class="trip-total-cost">${fmtDollar(r.total_cost)}</span>
        </div>
      </td>
      <td class="trip-nav-col">
        <button class="trip-nav-btn" data-nav="1" title="Navigate">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M6.5 1L12 6.5L6.5 12M2 6.5H12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </td>
    </tr>`;
  }).join("");

  // Add station markers + fit bounds
  const bounds = [[data.home.lat, data.home.lng], [data.dest.lat, data.dest.lng]];
  stations.slice(0, 8).forEach((s, i) => {
    const color = STATION_COLORS[Math.min(i, STATION_COLORS.length - 1)];
    const m = L.marker([s.latitude, s.longitude], {
      icon: makePinIcon(color, String(i + 1)),
      zIndexOffset: 500 - i,
    })
    .addTo(tripMap)
    .bindPopup(
      `<strong>${escapeHtml(s.brand || s.name)}</strong><br>` +
      `${escapeHtml(s.address_line1 || "")}${s.locality ? ", " + escapeHtml(s.locality) : ""}<br>` +
      `Pump: ${fmtPrice(s.price)} &nbsp;·&nbsp; Effective: ${fmtPrice(s.effective_cpl)}<br>` +
      `Detour: ${s.detour_km} km`
    );
    tripStationLayers.push(m);
    bounds.push([s.latitude, s.longitude]);
  });

  tripMap.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: 13 });

  // Auto-draw route for best station
  if (stations.length) {
    drawTripRoute(stations[0].latitude, stations[0].longitude);
  }
}

async function drawTripRoute(stationLat, stationLng) {
  if (!tripMap || !tripHomeCoords || !tripDestCoords) return;
  const requestId = ++tripRouteRequestId;
  const home = { ...tripHomeCoords };
  const dest = { ...tripDestCoords };

  // Highlight the active row
  document.querySelectorAll("#tripResultRows tr").forEach(r => {
    r.classList.toggle("active-route-row",
      parseFloat(r.dataset.lat) === stationLat && parseFloat(r.dataset.lng) === stationLng
    );
  });

  try {
    const params = new URLSearchParams({
      home_lat:    home.lat,
      home_lng:    home.lng,
      station_lat: stationLat,
      station_lng: stationLng,
      dest_lat:    tripDestCoords.lat,
      dest_lng:    tripDestCoords.lng,
    });
    const data = await api(`/api/route?`);
    if (requestId !== tripRouteRequestId) return;

    if (tripRouteLayer) { tripMap.removeLayer(tripRouteLayer); tripRouteLayer = null; }

    // GeoJSON coords are [lon, lat]; Leaflet wants [lat, lon]
    const latlngs = data.coordinates.map(([lon, lat]) => [lat, lon]);
    tripRouteLayer = L.polyline(latlngs, {
      color: "#5AA9FF",
      weight: 4,
      opacity: 0.85,
      lineJoin: "round",
    }).addTo(tripMap);
  } catch (err) {
    console.warn("Route draw failed", err);
  }
}

// ── View switching ───────────────────────────────────────

function switchView(view) {
  document.querySelectorAll(".view-pane").forEach(p =>
    p.classList.toggle("active", p.dataset.view === view));
  document.querySelectorAll(".view-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.view === view);
    t.setAttribute("aria-selected", t.dataset.view === view ? "true" : "false");
  });
  if (view === "trip" && tripMap) setTimeout(() => tripMap.invalidateSize(), 60);
  localStorage.setItem("gaswatch-view", view);
}

document.getElementById("tabTrip").addEventListener("click", () => switchView("trip"));
document.getElementById("tabStats").addEventListener("click", () => switchView("stats"));
switchView(localStorage.getItem("gaswatch-view") || "trip");

document.getElementById("tripCalcBtn").addEventListener("click", runTripCalc);
document.getElementById("tripStartSource").addEventListener("change", e => applyTripSource("start", e.target.value));
document.getElementById("tripDestSource").addEventListener("change", e => applyTripSource("dest", e.target.value));
document.getElementById("tripCarSelect").addEventListener("change", () => {
  invalidateTripCalculation();
  updateRangeHint();
  scheduleTripAutoCalc();
});
document.getElementById("tripTankPct").addEventListener("input", () => {
  invalidateTripCalculation();
  updateRangeHint();
  if (currentTripFuelPlan()) scheduleTripAutoCalc();
});
document.getElementById("tripFuelSelect").addEventListener("change", () => {
  invalidateTripCalculation();
  scheduleTripAutoCalc();
});
initTripMap();

document.getElementById("fuelSelect").addEventListener("change", refresh);
document.getElementById("rangeSelect").addEventListener("change", refresh);

// ── Nav Picker ───────────────────────────────────────────

function openNavPicker(lat, lng, name, addr) {
  const hasCoords = lat && lng;
  const dest = hasCoords ? `${lat},${lng}` : null;
  const query = encodeURIComponent((name || "") + (addr ? " " + addr : ""));

  document.getElementById("navPickerTitle").textContent = name || "Navigate to station";
  document.getElementById("navWaze").href  = dest
    ? `https://waze.com/ul?ll=${dest}&navigate=yes`
    : `https://waze.com/ul?q=${query}&navigate=yes`;
  document.getElementById("navGoogle").href = dest
    ? `https://www.google.com/maps/dir/?api=1&destination=${dest}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
  document.getElementById("navApple").href  = dest
    ? `https://maps.apple.com/?daddr=${dest}`
    : `https://maps.apple.com/?q=${query}`;

  document.getElementById("navPicker").hidden = false;
}

document.getElementById("navPickerClose").addEventListener("click", () => {
  document.getElementById("navPicker").hidden = true;
});
document.getElementById("navPicker").addEventListener("click", e => {
  if (e.target === e.currentTarget) document.getElementById("navPicker").hidden = true;
});

// Trip result rows: nav button opens nav picker; row click draws route
document.getElementById("tripResultRows").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-lat]");
  if (!tr) return;
  if (e.target.closest("[data-nav]")) {
    openNavPicker(tr.dataset.lat, tr.dataset.lng, tr.dataset.name, tr.dataset.addr);
    return;
  }
  drawTripRoute(parseFloat(tr.dataset.lat), parseFloat(tr.dataset.lng));
});

// All other station tables: open nav picker
["nearMeRows", "stationRows", "priceRows"].forEach(id => {
  document.getElementById(id).addEventListener("click", e => {
    const tr = e.target.closest("tr[data-lat]");
    if (!tr) return;
    openNavPicker(tr.dataset.lat, tr.dataset.lng, tr.dataset.name, tr.dataset.addr);
  });
});

document.getElementById("priceViewToggle").addEventListener("click", () => {
  setPriceView(!priceMapMode);
});

document.getElementById("filterReset").addEventListener("click", () => {
  cityFilter.clear();
  syncCityFilterUi();
  renderFiltered();
});

document.addEventListener("change", e => {
  if (!e.target.matches(".rows-select")) return;
  const tableId = e.target.id.replace("limit-", "");
  switch (tableId) {
    case "cityRows":
      if (lastData) renderCityRows(lastData.summary.cities);
      break;
    case "runRows":
      if (lastData) renderRuns(lastData.runs.runs);
      break;
    case "priceRows":
      if (lastData) renderPrices(lastData.prices.stations);
      break;
    case "stationRows":
      if (lastData) renderStationFocus(lastData.prices.stations);
      break;
    case "nearMeRows":
      if (lastNearMeData) renderNearMe(lastNearMeData);
      break;
    case "tripResultRows":
      if (lastTripData) renderTripResults(lastTripData);
      break;
  }
});

refresh().catch(err => {
  document.getElementById("scanStatus").textContent = "Error loading data";
  document.getElementById("statusDot").className = "status-dot err";
  console.error(err);
});
