import { createServer } from "node:http";

const BASE_URL = "https://stat.gov.ua/sdmx/workspaces/default:integration/registry/sdmx";
const DEFAULT_AGENCY = "SSSU";
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

async function upstream(url, accept = "application/xml") {
  const key = `${accept} ${url}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached;

  const response = await fetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": "stat-gov-ua-js-machine-readable-app/1.0"
    }
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") || accept;
  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  const value = { time: Date.now(), body, contentType };
  cache.set(key, value);
  return value;
}

function apiUrl(path, query = {}) {
  const params = new URLSearchParams(query);
  return `${BASE_URL}${path}${params.size ? `?${params}` : ""}`;
}

function dataUrl({ flow, version = "latest", key = "*", agency = DEFAULT_AGENCY }) {
  return `${BASE_URL}/3.0/data/dataflow/${encodeURIComponent(agency)}/${encodeURIComponent(flow)}/${encodeURIComponent(version)}/${encodeURIComponent(key).replaceAll("%2A", "*").replaceAll("%2E", ".")}`;
}

function dataQuery(searchParams) {
  const query = new URLSearchParams();
  for (const [from, to] of [
    ["first", "firstNObservations"],
    ["last", "lastNObservations"],
    ["updated_after", "updatedAfter"]
  ]) {
    const value = searchParams.get(from);
    if (value) query.set(to, value);
  }
  return query;
}

function withQuery(url, query) {
  return query.size ? `${url}?${query}` : url;
}

function structureUrl({ flow, version = "latest", agency = DEFAULT_AGENCY }) {
  return apiUrl(`/3.0/structure/dataflow/${encodeURIComponent(agency)}/${encodeURIComponent(flow)}/${encodeURIComponent(version)}`, {
    detail: "full",
    references: "all"
  });
}

function requireSafe(params, name) {
  const value = params.get(name);
  if (!value) throw new Error(`Missing required query parameter: ${name}`);
  if (!/^[A-Za-z0-9_.*+\-]+$/.test(value)) throw new Error(`Unsafe value for ${name}`);
  return value;
}

function xmlAttr(text, attr) {
  const match = text.match(new RegExp(`${attr}="([^"]*)"`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function localizedBlock(block, tag, lang) {
  const exact = block.match(new RegExp(`<[^>]*:${tag}[^>]*xml:lang="${lang}"[^>]*>([\\s\\S]*?)</[^>]*:${tag}>`, "i"));
  if (exact) return decodeXml(exact[1].trim());
  const fallback = block.match(new RegExp(`<[^>]*:${tag}[^>]*>([\\s\\S]*?)</[^>]*:${tag}>`, "i"));
  return fallback ? decodeXml(fallback[1].trim()) : "";
}

function parseDataflows(xml, { q = "", lang = "uk", limit = 200 } = {}) {
  const flows = [];
  const regex = /<[^>]*:Dataflow\b[\s\S]*?<\/[^>]*:Dataflow>/gi;
  for (const match of xml.matchAll(regex)) {
    const block = match[0];
    const row = {
      agency: xmlAttr(block, "agencyID") || DEFAULT_AGENCY,
      id: xmlAttr(block, "id"),
      version: xmlAttr(block, "version"),
      name: localizedBlock(block, "Name", lang),
      description: localizedBlock(block, "Description", lang)
    };
    if (!row.id) continue;
    const haystack = Object.values(row).join(" ").toLowerCase();
    if (!q || haystack.includes(q.toLowerCase())) flows.push(row);
    if (flows.length >= limit) break;
  }
  return flows;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        i += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, parseValue(values[index] ?? "")])));
}

function parseValue(value) {
  const normalized = String(value).trim().replace(",", ".");
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) && /^-?\d+([.,]\d+)?$/.test(String(value).trim()) ? number : value;
}

function rowsToCsv(rows) {
  if (!rows.length) return "";
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    fields.map(csvEscape).join(","),
    ...rows.map((row) => fields.map((field) => csvEscape(row[field] ?? "")).join(","))
  ].join("\n");
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

async function fetchRows(params, query = new URLSearchParams()) {
  const url = withQuery(dataUrl(params), query);
  const csv = await upstream(url, "text/csv");
  if (/csv|text\/plain/i.test(csv.contentType) && csv.body.includes(",")) {
    return parseCsv(csv.body);
  }

  const xml = await upstream(url, "application/xml");
  return parseGenericSdmxXml(xml.body);
}

function parseGenericSdmxXml(xml) {
  const rows = [];
  const seriesRegex = /<[^>]*:?Series\b[\s\S]*?<\/[^>]*:?Series>/gi;
  for (const match of xml.matchAll(seriesRegex)) {
    const series = match[0];
    const base = {};
    const key = (series.match(/<[^>]*:?SeriesKey\b[\s\S]*?<\/[^>]*:?SeriesKey>/i) || [""])[0];
    for (const value of key.matchAll(/<[^>]*:?Value\b[^>]*>/gi)) {
      base[xmlAttr(value[0], "id") || "dimension"] = xmlAttr(value[0], "value");
    }
    for (const obsMatch of series.matchAll(/<[^>]*:?Obs\b[\s\S]*?<\/[^>]*:?Obs>/gi)) {
      const obs = obsMatch[0];
      const row = { ...base };
      const dim = (obs.match(/<[^>]*:?ObsDimension\b[^>]*>/i) || [""])[0];
      const obsValue = (obs.match(/<[^>]*:?ObsValue\b[^>]*>/i) || [""])[0];
      if (dim) row[xmlAttr(dim, "id") || "TIME_PERIOD"] = xmlAttr(dim, "value");
      if (obsValue) row[xmlAttr(obsValue, "id") || "OBS_VALUE"] = parseValue(xmlAttr(obsValue, "value"));
      rows.push(row);
    }
  }
  return rows;
}

function values(rows, metric) {
  return rows.map((row) => row[metric]).filter((value) => typeof value === "number" && Number.isFinite(value));
}

function applyLocalLimit(rows, searchParams) {
  const limit = searchParams.get("limit") || "1000";
  if (limit.toLowerCase() === "all") return rows;
  const size = Number(limit);
  return Number.isFinite(size) && size >= 0 ? rows.slice(0, size) : rows.slice(0, 1000);
}

function summarize(rows, metric = "OBS_VALUE") {
  const nums = values(rows, metric);
  const latest = rows.length ? [...rows].sort((a, b) => String(b.TIME_PERIOD || "").localeCompare(String(a.TIME_PERIOD || "")))[0] : null;
  const result = { rows: rows.length, metric, numericRows: nums.length, latest };
  if (nums.length) {
    result.sum = nums.reduce((sum, value) => sum + value, 0);
    result.min = Math.min(...nums);
    result.max = Math.max(...nums);
    result.avg = result.sum / nums.length;
  }
  return result;
}

function aggregate(rows, groupBy, metric = "OBS_VALUE") {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[groupBy] ?? "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => ({ [groupBy]: key, ...summarize(groupRows, metric) }))
    .sort((a, b) => String(a[groupBy]).localeCompare(String(b[groupBy])));
}

function send(response, status, body, contentType = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

async function router(request, response) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      send(response, 200, indexHtml, "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/dataflows") {
      const xml = await upstream(apiUrl("/2.1/dataflow", { detail: "full" }));
      send(response, 200, {
        dataflows: parseDataflows(xml.body, {
          q: url.searchParams.get("q") || "",
          lang: url.searchParams.get("lang") || "uk",
          limit: Number(url.searchParams.get("limit") || 200)
        })
      });
      return;
    }
    if (url.pathname === "/api/datastructure") {
      const flow = requireSafe(url.searchParams, "flow");
      const xml = await upstream(structureUrl({
        flow,
        version: url.searchParams.get("version") || "latest",
        agency: url.searchParams.get("agency") || DEFAULT_AGENCY
      }));
      send(response, 200, xml.body, xml.contentType);
      return;
    }
    if (url.pathname === "/api/data") {
      const flow = requireSafe(url.searchParams, "flow");
      const params = {
        flow,
        version: url.searchParams.get("version") || "latest",
        key: url.searchParams.get("key") || "*",
        agency: url.searchParams.get("agency") || DEFAULT_AGENCY
      };
      const format = (url.searchParams.get("format") || "json").toLowerCase();
      if (format === "raw") {
        const raw = await upstream(withQuery(dataUrl(params), dataQuery(url.searchParams)), "application/xml");
        send(response, 200, raw.body, raw.contentType);
        return;
      }
      const rows = applyLocalLimit(await fetchRows(params, dataQuery(url.searchParams)), url.searchParams);
      if (format === "csv") {
        send(response, 200, rowsToCsv(rows), "text/csv; charset=utf-8");
      } else {
        send(response, 200, { source: "stat.gov.ua SDMX API", ...params, rows });
      }
      return;
    }
    if (url.pathname === "/api/analyze") {
      const flow = requireSafe(url.searchParams, "flow");
      const params = {
        flow,
        version: url.searchParams.get("version") || "latest",
        key: url.searchParams.get("key") || "*",
        agency: url.searchParams.get("agency") || DEFAULT_AGENCY
      };
      const metric = url.searchParams.get("metric") || "OBS_VALUE";
      const groupBy = url.searchParams.get("group_by") || "";
      const rows = applyLocalLimit(await fetchRows(params, dataQuery(url.searchParams)), url.searchParams);
      const payload = { source: "stat.gov.ua SDMX API", ...params, summary: summarize(rows, metric) };
      if (groupBy) payload.groups = aggregate(rows, groupBy, metric);
      send(response, 200, payload);
      return;
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, 500, { error: error.message });
  }
}

const indexHtml = `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>stat.gov.ua data explorer</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, Segoe UI, Arial, sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #171717; }
    header { padding: 28px clamp(16px, 4vw, 48px); background: #163b3a; color: white; }
    main { padding: 24px clamp(16px, 4vw, 48px); display: grid; gap: 18px; }
    section { background: white; border: 1px solid #ddd9cf; border-radius: 8px; padding: 18px; }
    label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; }
    input, select, button { font: inherit; border: 1px solid #c7c2b8; border-radius: 6px; padding: 9px 10px; }
    button { cursor: pointer; background: #d6502f; color: white; border-color: #d6502f; font-weight: 700; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); align-items: end; }
    .flows { max-height: 280px; overflow: auto; display: grid; gap: 8px; margin-top: 14px; }
    .flow { text-align: left; background: #f2eee5; color: #171717; border-color: #d8d0c2; }
    pre { overflow: auto; max-height: 460px; background: #151515; color: #f4f4f0; padding: 14px; border-radius: 8px; }
    @media (prefers-color-scheme: dark) {
      body { background: #151515; color: #f4f4f0; }
      section { background: #20201e; border-color: #3c3832; }
      input, select { background: #151515; color: #f4f4f0; border-color: #555048; }
      .flow { background: #2c2925; color: #f4f4f0; border-color: #4b453c; }
    }
  </style>
</head>
<body>
  <header>
    <h1>stat.gov.ua data explorer</h1>
    <p>Пошук наборів Держстата, видача JSON/CSV, агрегація та базовая аналітика.</p>
  </header>
  <main>
    <section>
      <div class="grid">
        <label>Пошук набора <input id="q" value="energy"></label>
        <label>Мова <select id="lang"><option value="uk">uk</option><option value="en">en</option></select></label>
        <button id="search">Знайти</button>
      </div>
      <div id="flows" class="flows"></div>
    </section>
    <section>
      <div class="grid">
        <label>Flow <input id="flow" value="DF_SUPPLY_USE_ENERGY"></label>
        <label>Version <input id="version" value="14.0.0"></label>
        <label>SDMX key <input id="key" value="*"></label>
        <label>Last observations <input id="last" value="20"></label>
        <label>Local row limit <input id="limit" value="500"></label>
        <label>Group by <input id="group_by" value="TIME_PERIOD"></label>
        <button id="load">JSON</button>
        <button id="csv">CSV</button>
        <button id="analyze">Analyze</button>
      </div>
      <pre id="out">Готово.</pre>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const out = (value) => $("out").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    async function getJson(url) {
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || response.statusText);
      return data;
    }
    $("search").onclick = async () => {
      try {
        const data = await getJson("/api/dataflows?q=" + encodeURIComponent($("q").value) + "&lang=" + $("lang").value);
        $("flows").innerHTML = "";
        data.dataflows.forEach((flow) => {
          const button = document.createElement("button");
          button.className = "flow";
          button.textContent = flow.id + " (" + flow.version + ") - " + flow.name;
          button.onclick = () => {
            $("flow").value = flow.id;
            $("version").value = flow.version;
          };
          $("flows").appendChild(button);
        });
        out(data);
      } catch (error) { out(String(error)); }
    };
    $("load").onclick = async () => {
      try {
        out(await getJson("/api/data?flow=" + $("flow").value + "&version=" + $("version").value + "&key=" + encodeURIComponent($("key").value) + "&last=" + $("last").value + "&limit=" + $("limit").value + "&format=json"));
      } catch (error) { out(String(error)); }
    };
    $("csv").onclick = async () => {
      const response = await fetch("/api/data?flow=" + $("flow").value + "&version=" + $("version").value + "&key=" + encodeURIComponent($("key").value) + "&last=" + $("last").value + "&limit=" + $("limit").value + "&format=csv");
      out(await response.text());
    };
    $("analyze").onclick = async () => {
      try {
        out(await getJson("/api/analyze?flow=" + $("flow").value + "&version=" + $("version").value + "&key=" + encodeURIComponent($("key").value) + "&last=" + $("last").value + "&limit=" + $("limit").value + "&group_by=" + $("group_by").value));
      } catch (error) { out(String(error)); }
    };
  </script>
</body>
</html>`;

const port = Number(process.env.PORT || 8080);
createServer(router).listen(port, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
