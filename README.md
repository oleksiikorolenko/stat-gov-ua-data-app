# Stat.gov.ua machine-readable data app

Small JavaScript/Node.js web application for retrieving datasets from the State
Statistics Service of Ukraine SDMX API, exposing them as machine-readable
JSON/CSV and providing basic aggregation and analysis endpoints.

## Features

- Lists available SDMX dataflows from `stat.gov.ua`
- Fetches raw SDMX XML or normalized table-like JSON/CSV
- Provides aggregation by any returned dimension
- Computes simple analysis: count, sum, min, max, average, latest observation
- Includes a browser UI for quick exploration
- Uses only built-in Node.js modules and `fetch`

## Run

```powershell
npm start
```

Open:

```text
http://127.0.0.1:8080
```

## API

```text
GET /api/dataflows?q=energy&lang=uk
GET /api/datastructure?flow=DF_SUPPLY_USE_ENERGY&version=14.0.0
GET /api/data?flow=DF_SUPPLY_USE_ENERGY&version=14.0.0&key=*&last=20&limit=500&format=json
GET /api/data?flow=DF_SUPPLY_USE_ENERGY&version=14.0.0&key=*&last=20&limit=500&format=csv
GET /api/analyze?flow=DF_SUPPLY_USE_ENERGY&version=14.0.0&key=*&last=20&limit=500&group_by=TIME_PERIOD&metric=OBS_VALUE
```

Large unfiltered dataflows may be slow or rejected by the upstream API. Use
SDMX keys to filter dimensions when possible. You can also pass `first`,
`last`, and `updated_after`, which are forwarded to the SDMX API as
`firstNObservations`, `lastNObservations`, and `updatedAfter`.
The local `limit` parameter caps returned or analyzed rows; use `limit=all`
for a full response.

## Upstream

The app uses the official State Statistics Service of Ukraine SDMX API:

- `https://stat.gov.ua/sdmx/workspaces/default:integration/registry/sdmx/2.1/dataflow?detail=full`
- `https://stat.gov.ua/sdmx/workspaces/default:integration/registry/sdmx/3.0/data/dataflow/SSSU/{flow}/{version}/{key}`
