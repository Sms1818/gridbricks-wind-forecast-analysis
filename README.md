# WindLens

**See the forecast that was available when the decision mattered.**

Wind forecasts change as new information becomes available. But when evaluating a procurement decision, only the forecasts published at that time should count.

WindLens analyzes historical Great Britain wind-generation forecasts against actual generation. Choose a delivery window and decision cutoff to measure forecast accuracy, inspect data quality, and compare how forecasts changed between two decision times.

**Built with React, TypeScript, FastAPI, Python, Pandas, and NumPy.**

[Live Demo](#deployment) · [Features](#features) · [Getting Started](#getting-started) · [Methodology](#methodology)

---

## The problem

Day-ahead electricity procurement decisions depend on information available at a particular point in time. Evaluating those decisions against forecasts published afterward can introduce look-ahead bias, making the information available at decision time appear better than it actually was.

This project addresses that problem by making the forecast publication cutoff an explicit input to historical analysis.

Instead of comparing actual generation against whichever forecast is available today, the application evaluates the latest eligible forecast that had been published by the selected decision cutoff.

The result is a more transparent view of historical forecast accuracy and the changes introduced by subsequently published forecasts.

## Features

- **Cutoff-aware analysis** — Evaluate forecasts using only publications available at or before the selected decision time.
- **Forecast accuracy metrics** — Calculate Mean Absolute Error (MAE) and Root Mean Squared Error (RMSE) over valid matched hours.
- **Data-quality diagnostics** — Identify missing forecasts, incomplete or ambiguous actual readings, and conflicting forecast values.
- **Forecast versus actuals** — Inspect hourly generation values and compare forecasts with observed wind generation.
- **Decision scenario comparison** — Compare two cutoffs over the same delivery window, including metric differences and changes in forecast values.
- **CSV export** — Export matched analysis rows for further investigation.
- **Explicit missing-data handling** — Keep unavailable or invalid observations distinct from genuine zero-generation values.

## How it works

The application combines forecast publications with historical actual-generation observations and evaluates them within a user-selected delivery window and decision cutoff.

```text
Elexon historical data
        |
        v
Forecast publications + actual generation
        |
        v
Apply delivery window and decision cutoff
        |
        v
Select latest eligible forecast per hour
        |
        v
Validate and aggregate half-hourly actuals
        |
        v
Match valid observations
        |
        v
Calculate MAE / RMSE and data-quality diagnostics
        |
        v
Visualize results, compare scenarios, export CSV
```

### Data sources

| Dataset | Purpose |
|---|---|
| `WINDFOR` | Wind-generation forecast publications |
| `FUELHH` | Half-hourly actual-generation readings, filtered to wind |

The historical analysis dataset covers **1–31 January 2026**.

## Methodology

### 1. Forecast Selection at Decision Time

For a selected decision cutoff, only forecast publications released at or before that time are eligible for analysis:

```text
Publication time <= Decision cutoff
```

For each delivery timestamp, the latest eligible publication is selected. Publications released after the cutoff are excluded to prevent future information from leaking into the historical evaluation.

Conflicting values associated with the latest publication are treated as a data-quality issue rather than resolved through an arbitrary selection.

### 2. Constructing Hourly Actual Generation

Actual generation is provided at half-hourly resolution. An hourly observation is accepted only when the hour has exactly one reading at `:00` and exactly one reading at `:30`.

```text
Hourly actual = (Reading at :00 + Reading at :30) / 2
```

Missing readings make the hour incomplete. Duplicate readings make it ambiguous. Neither condition is silently converted into zero or accepted as a valid hourly observation.

### 3. Matching and Accuracy Metrics

Forecasts and actuals are matched by delivery hour. Only valid matched observations contribute to the accuracy metrics.

**Mean Absolute Error (MAE)**

```text
MAE = Sum of absolute forecast errors / Number of valid matched hours
```

**Root Mean Squared Error (RMSE)**

```text
RMSE = Square root of (Sum of squared forecast errors / Number of valid matched hours)
```

Here, each forecast error is the forecast generation minus the actual generation for a matched hour. The number of valid matched hours is the number of observations included in the calculation.

MAE summarizes the average absolute forecast error, while RMSE gives greater weight to larger errors. If no valid matched observations exist, both metrics are reported as unavailable rather than zero.

### 4. Data-quality diagnostics

The application reports the expected delivery hours and identifies observations that cannot be evaluated reliably.

| Diagnostic | Meaning |
|---|---|
| Missing forecast hours | Expected hours without a usable forecast |
| Incomplete actual hours | Hours missing a required half-hourly reading |
| Ambiguous actual hours | Hours with duplicate half-hourly readings |
| Conflicting forecast hours | Hours with conflicting values in the latest eligible publication |

These diagnostics provide context for interpreting accuracy metrics. A metric calculated from a small valid subset should not be mistaken for complete coverage of the requested window.

### 5. Comparing decision cutoffs

Scenario comparison uses the same delivery window with two different decision cutoffs. Each scenario independently applies its cutoff and calculates metrics from its own valid matched hours.

The forecast comparison examines expected delivery hours and classifies them as:

- **Changed:** Both scenarios have usable forecasts, but the forecast values differ.
- **Unchanged:** Both scenarios have usable forecasts with the same value.
- **Unavailable or ambiguous:** Either scenario lacks a usable forecast or has conflicting latest values.

Metric differences must be interpreted alongside matched-hour counts and coverage. This is a historical comparison of available information, not proof that later forecasts improve procurement outcomes.

## Technology stack

| Component | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend API | Python, FastAPI, Uvicorn |
| Data processing | Pandas, NumPy |
| Validation | Pydantic |
| Backend testing | Pytest |
| Data source | Elexon |
| Containerization | Docker, Docker Compose |
| Web server and reverse proxy | Nginx |

## Getting started

### Prerequisites

- Python 3.12 or a compatible Python version
- Node.js and npm
- Git

### 1. Clone the repository

```bash
git clone https://github.com/Sms1818/gridbricks-wind-forecast-analysis.git
cd gridbricks-wind-forecast-analysis
```

### 2. Start the backend

```bash
cd backend

python3 -m venv .venv
source .venv/bin/activate

python -m pip install -r requirements.txt
uvicorn main:app --reload
```

The backend runs using Uvicorn. Keep this terminal open while developing.

### 3. Start the frontend

In a separate terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev
```

Ensure the frontend API configuration points to a backend address reachable from your browser and that the backend's CORS configuration permits the frontend origin.

## Docker

WindLens runs as two Docker containers:

- **Frontend:** The React application is built with Vite and served by Nginx.
- **Backend:** The FastAPI application runs under Uvicorn.
- **Reverse proxy:** Nginx forwards `/api/` requests to the backend and exposes the health endpoint through the frontend port.

### Prerequisites

- Git
- Docker Desktop or Docker Engine with the Docker Compose plugin
- Internet access to download base images and install dependencies during the initial build

### 1. Clone the repository

```bash
git clone https://github.com/Sms1818/gridbricks-wind-forecast-analysis.git
cd gridbricks-wind-forecast-analysis
```

### 2. Build and start the application

Run this command from the repository root:

```bash
docker compose up --build -d
```

Docker Compose builds both images and starts the services. The frontend waits for the backend health check to pass before starting.

### 3. Open the application

| Resource | URL |
|---|---|
| Web application | http://localhost:8080 |
| Health check | http://localhost:8080/health |
| API documentation | http://localhost:8080/docs |
| OpenAPI schema | http://localhost:8080/openapi.json |

The frontend's Nginx configuration proxies `/api/` requests to the backend container. The backend port is exposed within the Compose network and is not published directly to the host.

### 4. Check service status and logs

Check container status:

```bash
docker compose ps
```

Follow logs from both services:

```bash
docker compose logs -f
```

Follow logs for a specific service:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

### 5. Stop the application

```bash
docker compose down
```

This stops and removes the containers and Compose network. It does not remove the built images.

### Troubleshooting

- If port `8080` is already in use, stop the conflicting service or change the host port mapping in `compose.yaml`.
- The first build can take several minutes while Docker downloads base images and installs dependencies.
- If the backend does not become healthy, inspect its logs with `docker compose logs backend`.

## Deployment

The challenge requires a deployed application on Vercel or Heroku.

- **Frontend:** Not yet deployed.
- **Backend API:** Not yet deployed.
- **Hosting architecture:** Local Docker Compose setup verified; public deployment remains outstanding.

Update this section with the actual public URLs and hosting arrangement after deployment. Before marking deployment complete, verify the live application, API connectivity, and a representative analysis request.

## Testing

The following test results have been recorded during development:

| Check | Result |
|---|---|
| Backend tests (`test_accuracy.py`, `test_api.py`, `test_api_errors.py`) | 37 passed |
| Frontend tests | 36 passed |
| Frontend production build | Passed |
| Docker Compose build and startup | Passed locally |

Run the backend tests from the repository root:

```bash
python -m pytest backend/test_accuracy.py backend/test_api.py backend/test_api_errors.py -q
```

Run the frontend tests and production build:

```bash
cd frontend
npm test -- --run
npm run build
```

To rebuild and start the complete application with Docker:

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:8080/health
```

The health endpoint should return:

```json
{"status":"ok"}
```

The Docker Compose application has been built and run locally. Public deployment still needs to be completed and verified before submission.

## Limitations

- The analysis covers a historical dataset for January 2026 rather than guaranteeing access to live forecasts.
- Accuracy metrics are calculated over valid matched observations, not necessarily every expected delivery hour.
- Comparing scenarios with different matched-hour counts requires care when interpreting metric changes.
- The application does not model electricity prices, procurement volumes, trading strategies, or financial outcomes.
- Historical forecast comparisons do not establish causation or guarantee improved decisions.

## AI Use

I used AI tools during development to help work through implementation issues, debug errors, and refine parts of the application and documentation. I tested the application and reviewed the changes as I worked, and I'm responsible for the code and the final submission.

## Future work

Potential extensions include longer historical evaluation windows, additional forecast-error breakdowns, saved scenario configurations, and automated continuous integration for backend, frontend, and container tests.

These are potential extensions rather than claims about existing functionality.
