import { useMemo, useState } from 'react'
import {
  AnalysisApiError,
  runAnalysis,
} from './api/analysisApi'
import {
  getAnalysisStats,
  getExpectedHours,
  getLeadTimeHours,
  getPublicationWindow,
  getSettlementRange,
  type AnalysisRequest,
  type AnalysisResponse,
  type ForecastComparison,
} from './domain/analysis'
import ForecastChart from './components/ForecastChart'
import AppNavigation, {
  type AppScreen,
} from './components/AppNavigation'
import './App.css'
import './components/FeatureScreens.css'

interface ScenarioInputs {
  cutoffDate: string
  cutoffTime: string
  deliveryDate: string
  startTime: string
  endDate: string
  endTime: string
}

type SortKey =
  | 'startTime'
  | 'forecastGeneration'
  | 'actualGeneration'
  | 'error'
  | 'absoluteError'
  | 'publishTime'
  | 'leadTime'

const initialInputs: ScenarioInputs = {
  cutoffDate: '2026-01-13',
  cutoffTime: '09:00',
  deliveryDate: '2026-01-14',
  startTime: '00:00',
  endDate: '2026-01-15',
  endTime: '00:00',
}

const dates = {
  min: '2026-01-01',
  max: '2026-01-31',
}

const hourOptions = Array.from(
  { length: 24 },
  (_, hour) => `${String(hour).padStart(2, '0')}:00`,
)

const cutoffOptions = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2)
  const minute = index % 2 === 0 ? '00' : '30'
  return `${String(hour).padStart(2, '0')}:${minute}`
})

function formatUtc(value: string): string {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value)) + ' UTC'
  )
}

function toUtcIso(date: string, time: string): string {
  return `${date}T${time}:00Z`
}

function formatMw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '—'
  }

  return `${value.toLocaleString('en-GB', {
    maximumFractionDigits: 1,
  })} MW`
}

function formatSignedMw(value: number): string {
  const formatted = value.toLocaleString('en-GB', {
    maximumFractionDigits: 1,
  })

  return `${value > 0 ? '+' : ''}${formatted} MW`
}

function getErrorDirection(error: number): string {
  if (error > 0) return 'Over-forecast'
  if (error < 0) return 'Under-forecast'
  return 'Exact match'
}

function buildRequest(inputs: ScenarioInputs): AnalysisRequest {
  const deliveryStart = toUtcIso(
    inputs.deliveryDate,
    inputs.startTime,
  )
  const deliveryEnd = toUtcIso(inputs.endDate, inputs.endTime)
  const decisionCutoff = toUtcIso(
    inputs.cutoffDate,
    inputs.cutoffTime,
  )

  if (
    inputs.deliveryDate < dates.min ||
    inputs.deliveryDate > dates.max ||
    inputs.endDate < dates.min ||
    inputs.endDate > dates.max ||
    inputs.cutoffDate < dates.min ||
    inputs.cutoffDate > dates.max
  ) {
    throw new Error('Choose dates within January 2026.')
  }

  if (Date.parse(deliveryEnd) <= Date.parse(deliveryStart)) {
    throw new Error('Delivery end must be after delivery start.')
  }

  const durationHours =
    (Date.parse(deliveryEnd) - Date.parse(deliveryStart)) /
    (60 * 60 * 1000)

  if (durationHours > 168) {
    throw new Error('The delivery window cannot exceed 7 days.')
  }

  const publication = getPublicationWindow(
    deliveryStart,
    decisionCutoff,
  )
  const settlement = getSettlementRange(
    deliveryStart,
    deliveryEnd,
  )

  return {
    ...publication,
    ...settlement,
    decision_cutoff: decisionCutoff,
    delivery_start: deliveryStart,
    delivery_end: deliveryEnd,
  }
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="date"
        min={dates.min}
        max={dates.max}
        value={value}
        onChange={event => onChange(event.target.value)}
        required
      />
    </label>
  )
}

function TimeField({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {options.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}

function ScreenHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="results-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}

function EmptyState({
  title,
  description,
  onConfigure,
}: {
  title: string
  description: string
  onConfigure: () => void
}) {
  return (
    <section className="scenario" aria-labelledby="empty-state-heading">
      <p className="eyebrow">READY WHEN YOU ARE</p>
      <h2 id="empty-state-heading">{title}</h2>
      <p className="hint">{description}</p>
      <button type="button" onClick={onConfigure}>
        Configure a scenario
      </button>
    </section>
  )
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="summary-item">
      <span className="summary-label">{label}</span>
      <strong>{value}</strong>
      {detail && <span className="metric-detail">{detail}</span>}
    </div>
  )
}

function ScenarioSummary({
  result,
}: {
  result: AnalysisResponse
}) {
  return (
    <section className="coverage-note" aria-label="Active scenario">
      <strong>Active scenario · All times UTC</strong>
      <p>
        Decision cutoff: {formatUtc(result.decisionCutoff)}
      </p>
      <p>
        Delivery: {formatUtc(result.deliveryStart)} to{' '}
        {formatUtc(result.deliveryEnd)}
      </p>
    </section>
  )
}

function WorkflowSteps({
  activeStep,
  onConfigure,
  onAnalyze,
  onInvestigate,
}: {
  activeStep: 1 | 2 | 3
  onConfigure: () => void
  onAnalyze: () => void
  onInvestigate: () => void
}) {
  const steps = [
    {
      number: 1,
      title: 'Configure',
      description: 'Choose cutoff and delivery hours',
      action: onConfigure,
    },
    {
      number: 2,
      title: 'Analyze',
      description: 'Reconstruct and compare forecasts',
      action: onAnalyze,
    },
    {
      number: 3,
      title: 'Investigate',
      description: 'Inspect errors and hourly evidence',
      action: onInvestigate,
    },
  ] as const

  return (
    <section className="workflow-panel" aria-label="Analysis workflow">
      <div className="workflow-panel-heading">
        <div>
          <p className="eyebrow">YOUR WORKFLOW</p>
          <h2>From decision to evidence</h2>
        </div>
        <span className="workflow-scope">Historical replay · Jan 2026</span>
      </div>

      <div className="workflow-steps">
        {steps.map((step, index) => (
          <div className="workflow-step-wrap" key={step.number}>
            <button
              type="button"
              className={`workflow-step ${activeStep === step.number ? 'is-current' : ''
                } ${activeStep > step.number ? 'is-complete' : ''}`}
              onClick={step.action}
              aria-current={
                activeStep === step.number ? 'step' : undefined
              }
            >
              <span className="workflow-step-number">
                {activeStep > step.number ? '✓' : step.number}
              </span>
              <span className="workflow-step-copy">
                <strong>{step.title}</strong>
                <span>{step.description}</span>
              </span>
            </button>
            {index < steps.length - 1 && (
              <span className="workflow-connector" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function WorstHoursTable({
  rows,
}: {
  rows: ForecastComparison[]
}) {
  return (
    <section
      className="worst-hours-panel"
      aria-labelledby="worst-hours-heading"
    >
      <div className="worst-hours-heading">
        <p className="eyebrow">HOURS TO INVESTIGATE</p>
        <h2 id="worst-hours-heading">Largest forecast errors</h2>
        <p>
          The five matched delivery hours with the largest absolute
          difference between forecast and actual generation.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="worst-hours-empty">
          No matched hours are available to rank for this scenario.
        </p>
      ) : (
        <div className="worst-hours-table-scroll">
          <table className="worst-hours-table">
            <thead>
              <tr>
                <th scope="col">Delivery hour (UTC)</th>
                <th scope="col">Forecast</th>
                <th scope="col">Actual</th>
                <th scope="col">Signed error</th>
                <th scope="col">Direction</th>
                <th scope="col">Forecast published (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.startTime}>
                  <td>{formatUtc(row.startTime)}</td>
                  <td>{formatMw(row.forecastGeneration)}</td>
                  <td>{formatMw(row.actualGeneration)}</td>
                  <td
                    className={
                      row.error > 0
                        ? 'worst-error-positive'
                        : row.error < 0
                          ? 'worst-error-negative'
                          : ''
                    }
                  >
                    {formatSignedMw(row.error)}
                  </td>
                  <td>
                    <span
                      className={`error-direction ${row.error > 0
                        ? 'direction-over'
                        : row.error < 0
                          ? 'direction-under'
                          : 'direction-exact'
                        }`}
                    >
                      {getErrorDirection(row.error)}
                    </span>
                  </td>
                  <td>{formatUtc(row.publishTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="worst-hours-footnote">
        Ranked by absolute error, regardless of direction. These are
        observed differences, not estimates of financial loss.
      </p>
    </section>
  )
}

function HourlyDataTable({
  rows,
  deliveryStart,
  deliveryEnd,
  decisionCutoff,
}: {
  rows: ForecastComparison[]
  deliveryStart: string
  deliveryEnd: string
  decisionCutoff: string
}) {
  const [sortKey, setSortKey] = useState<SortKey>('absoluteError')
  const [descending, setDescending] = useState(true)

  const expectedHours = getExpectedHours(deliveryStart, deliveryEnd)

  const matchedByHour = useMemo(
    () => new Map(rows.map(row => [Date.parse(row.startTime), row])),
    [rows],
  )

  const unmatchedHours = useMemo(() => {
    const missing: string[] = []
    const start = Date.parse(deliveryStart)
    const end = Date.parse(deliveryEnd)
    const hourMs = 60 * 60 * 1000

    for (let timestamp = start; timestamp < end; timestamp += hourMs) {
      const hour = new Date(timestamp).toISOString()

      if (!matchedByHour.has(timestamp)) {
        missing.push(hour)
      }
    }

    return missing
  }, [deliveryStart, deliveryEnd, matchedByHour])

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      let comparison: number

      switch (sortKey) {
        case 'forecastGeneration':
          comparison = a.forecastGeneration - b.forecastGeneration
          break
        case 'actualGeneration':
          comparison = a.actualGeneration - b.actualGeneration
          break
        case 'error':
          comparison = a.error - b.error
          break
        case 'absoluteError':
          comparison = a.absoluteError - b.absoluteError
          break
        case 'publishTime':
          comparison =
            Date.parse(a.publishTime) - Date.parse(b.publishTime)
          break
        case 'leadTime':
          comparison =
            getLeadTimeHours(a.startTime, a.publishTime) -
            getLeadTimeHours(b.startTime, b.publishTime)
          break
        default:
          comparison = Date.parse(a.startTime) - Date.parse(b.startTime)
      }

      return (
        (descending ? -comparison : comparison) ||
        a.startTime.localeCompare(b.startTime)
      )
    })
  }, [rows, sortKey, descending])

  function changeSort(key: SortKey) {
    if (sortKey === key) {
      setDescending(current => !current)
    } else {
      setSortKey(key)
      setDescending(key === 'absoluteError')
    }
  }

  function sortButton(label: string, key: SortKey) {
    const active = sortKey === key
    const direction = active
      ? descending
        ? 'descending'
        : 'ascending'
      : 'none'

    return (
      <th scope="col" aria-sort={direction}>
        <button
          type="button"
          className="table-sort-button"
          onClick={() => changeSort(key)}
          aria-label={`Sort by ${label}${active
            ? `, ${descending ? 'descending' : 'ascending'}`
            : ''
            }`}
        >
          {label}
          {active ? (descending ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    )
  }

  function exportCsv() {
    const headers = [
      'delivery_hour_utc',
      'forecast_mw',
      'actual_mw',
      'signed_error_mw',
      'absolute_error_mw',
      'publication_time_utc',
      'lead_time_hours',
      'decision_cutoff_utc',
    ]

    const values = sortedRows.map(row => [
      row.startTime,
      row.forecastGeneration,
      row.actualGeneration,
      row.error,
      row.absoluteError,
      row.publishTime,
      getLeadTimeHours(row.startTime, row.publishTime).toFixed(2),
      decisionCutoff,
    ])

    const csv = [headers, ...values]
      .map(record =>
        record
          .map(value => `"${String(value).replace(/"/g, '""')}"`)
          .join(','),
      )
      .join('\r\n')

    const blob = new Blob([csv], {
      type: 'text/csv;charset=utf-8;',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = 'wind-forecast-hourly-analysis.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()

    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <section
      className="worst-hours-panel"
      aria-labelledby="hourly-comparison-heading"
    >
      <div className="worst-hours-heading">
        <p className="eyebrow">DELIVERY-HOUR RECONCILIATION</p>
        <h2 id="hourly-comparison-heading">Hourly comparison</h2>
        <p>
          Start with the largest absolute errors, or sort any column to
          investigate forecast values, actual generation, publication times,
          and lead times. All timestamps are UTC.
        </p>
      </div>

      <div
        className="hourly-coverage-grid"
        aria-label="Hourly data coverage"
      >
        <div className="hourly-coverage-item">
          <span>Expected hours</span>
          <strong>{expectedHours}</strong>
        </div>
        <div className="hourly-coverage-item">
          <span>Matched comparisons</span>
          <strong>{rows.length}</strong>
        </div>
        <div className="hourly-coverage-item">
          <span>Without a match</span>
          <strong>{unmatchedHours.length}</strong>
        </div>
        <div className="hourly-coverage-item">
          <span>Coverage</span>
          <strong>
            {expectedHours === 0
              ? '—'
              : `${((rows.length / expectedHours) * 100).toFixed(1)}%`}
          </strong>
        </div>
      </div>

      <div className="table-toolbar">
        <span>
          {rows.length} matched of {expectedHours} expected delivery hours
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={exportCsv}
          disabled={rows.length === 0}
        >
          Export matched rows (CSV)
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="worst-hours-empty">
          No matched hourly records are available to display or export.
        </p>
      ) : (
        <div className="worst-hours-table-scroll">
          <table className="worst-hours-table">
            <caption className="table-caption">
              Matched forecast and actual-generation observations
            </caption>
            <thead>
              <tr>
                {sortButton('Delivery hour (UTC)', 'startTime')}
                {sortButton('Forecast', 'forecastGeneration')}
                {sortButton('Actual', 'actualGeneration')}
                {sortButton('Signed error', 'error')}
                {sortButton('Absolute error', 'absoluteError')}
                {sortButton('Published (UTC)', 'publishTime')}
                {sortButton('Lead time', 'leadTime')}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(row => (
                <tr key={row.startTime}>
                  <td>{formatUtc(row.startTime)}</td>
                  <td>{formatMw(row.forecastGeneration)}</td>
                  <td>{formatMw(row.actualGeneration)}</td>
                  <td
                    className={
                      row.error > 0
                        ? 'worst-error-positive'
                        : row.error < 0
                          ? 'worst-error-negative'
                          : ''
                    }
                  >
                    {formatSignedMw(row.error)}
                    <span className="hourly-error-direction">
                      {getErrorDirection(row.error)}
                    </span>
                  </td>
                  <td>{formatMw(row.absoluteError)}</td>
                  <td>{formatUtc(row.publishTime)}</td>
                  <td>
                    {getLeadTimeHours(
                      row.startTime,
                      row.publishTime,
                    ).toFixed(1)}{' '}
                    h
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="worst-hours-footnote">
        The CSV contains matched comparisons only, in the current sort order.
        Missing observations are never filled with zero.
      </p>

      <section
        className="unmatched-hours-panel"
        aria-labelledby="unmatched-hours-heading"
      >
        <div className="worst-hours-heading">
          <p className="eyebrow">COVERAGE GAPS</p>
          <h3 id="unmatched-hours-heading">
            Hours without a matched comparison
          </h3>
          <p>
            These are expected delivery hours for which the analysis response
            contains no matched forecast-and-actual record. The current
            response does not identify whether the forecast, actual reading,
            or both caused each gap.
          </p>
        </div>

        {unmatchedHours.length === 0 ? (
          <p className="coverage-complete-message">
            Every expected delivery hour has a matched comparison.
          </p>
        ) : (
          <div className="worst-hours-table-scroll">
            <table className="worst-hours-table unmatched-hours-table">
              <caption className="table-caption">
                Expected delivery hours with no matched comparison
              </caption>
              <thead>
                <tr>
                  <th scope="col">Delivery hour (UTC)</th>
                  <th scope="col">Comparison status</th>
                </tr>
              </thead>
              <tbody>
                {unmatchedHours.map(hour => (
                  <tr key={hour}>
                    <td>{formatUtc(hour)}</td>
                    <td>
                      <span className="missing-comparison-status">
                        No matched comparison
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

export default function App() {
  const [activeScreen, setActiveScreen] =
    useState<AppScreen>('overview')
  const [inputs, setInputs] = useState<ScenarioInputs>(initialInputs)
  const [lastRunInputs, setLastRunInputs] =
    useState<ScenarioInputs | null>(null)
  const [result, setResult] = useState<AnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isStale =
    result !== null &&
    lastRunInputs !== null &&
    JSON.stringify(inputs) !== JSON.stringify(lastRunInputs)

  const stats = result ? getAnalysisStats(result) : null

  const selectedPublicationCount = result
    ? new Set(result.comparisons.map(row => row.publishTime)).size
    : 0

  function updateInput<K extends keyof ScenarioInputs>(
    key: K,
    value: ScenarioInputs[K],
  ) {
    setInputs(current => ({ ...current, [key]: value }))
    setError(null)
  }

  async function handleRun() {
    setLoading(true)
    setError(null)

    try {
      const request = buildRequest(inputs)
      const data = await runAnalysis(request)

      setResult(data)
      setLastRunInputs({ ...inputs })
      setActiveScreen('overview')
    } catch (err) {
      setError(
        err instanceof AnalysisApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong while running the analysis.',
      )
    } finally {
      setLoading(false)
    }
  }

  const pageTitles: Record<AppScreen, string> = {
    overview: 'Overview',
    scenario: 'Scenario Explorer',
    accuracy: 'Accuracy Analysis',
    hourly: 'Hourly Data',
    methodology: 'Data & Methodology',
  }

  const overviewStep: 1 | 2 | 3 = !result ? 1 : isStale ? 1 : 3

  return (
    <main className="app">
      <header className="page-header">
        <p className="eyebrow">GB NATIONAL WIND GENERATION</p>
        <h1>Wind Forecast Review</h1>
        <p>
          Reconstruct the wind forecast available at a decision cutoff
          and compare it with actual generation for the delivery period.
        </p>
      </header>

      <AppNavigation
        activeScreen={activeScreen}
        onNavigate={setActiveScreen}
      />

      <div className="screen-heading">
        <h2>{pageTitles[activeScreen]}</h2>
        {result && (
          <p>
            Active delivery window:{' '}
            {formatUtc(result.deliveryStart)} to{' '}
            {formatUtc(result.deliveryEnd)}
          </p>
        )}
      </div>

      {error && (
        <section className="error" role="alert">
          <strong>Analysis could not be completed</strong>
          <p>{error}</p>
          <p>Review the scenario inputs and try again.</p>
        </section>
      )}

      {loading && (
        <p className="hint" role="status" aria-live="polite">
          Fetching forecast and actual-generation data…
        </p>
      )}

      {isStale && (
        <p className="stale-notice" role="status">
          Scenario inputs have changed. Displayed results belong to the
          previous run. Run the analysis again to update them.
        </p>
      )}

      {activeScreen === 'scenario' && (
        <section className="scenario" aria-labelledby="scenario-heading">
          <p className="eyebrow">ANALYSIS SCENARIO · ALL TIMES UTC</p>
          <h2 id="scenario-heading">Define the decision scenario</h2>
          <p className="scenario-sentence">
            Evaluate forecasts available by{' '}
            <strong>
              {formatUtc(toUtcIso(inputs.cutoffDate, inputs.cutoffTime))}
            </strong>{' '}
            for delivery from{' '}
            <strong>
              {formatUtc(toUtcIso(inputs.deliveryDate, inputs.startTime))}
            </strong>{' '}
            to{' '}
            <strong>
              {formatUtc(toUtcIso(inputs.endDate, inputs.endTime))}
            </strong>
            . The delivery end time is exclusive.
          </p>

          <div className="controls">
            <div className="control-group">
              <h3>Decision cutoff</h3>
              <p className="field-help">
                The latest publication time eligible for the forecast
                reconstruction.
              </p>
              <DateField
                label="Cutoff date"
                value={inputs.cutoffDate}
                onChange={value => updateInput('cutoffDate', value)}
              />
              <TimeField
                label="Cutoff time (UTC)"
                value={inputs.cutoffTime}
                options={cutoffOptions}
                onChange={value => updateInput('cutoffTime', value)}
              />
            </div>

            <div className="control-group">
              <h3>Delivery window</h3>
              <p className="field-help">
                Select the delivery hours to compare against recorded
                wind generation. Maximum window: seven days.
              </p>
              <DateField
                label="Start date"
                value={inputs.deliveryDate}
                onChange={value => updateInput('deliveryDate', value)}
              />
              <TimeField
                label="Start time (UTC)"
                value={inputs.startTime}
                options={hourOptions}
                onChange={value => updateInput('startTime', value)}
              />
              <DateField
                label="End date"
                value={inputs.endDate}
                onChange={value => updateInput('endDate', value)}
              />
              <TimeField
                label="End time (UTC)"
                value={inputs.endTime}
                options={hourOptions}
                onChange={value => updateInput('endTime', value)}
              />
            </div>
          </div>

          <button type="button" onClick={handleRun} disabled={loading}>
            {loading ? 'Running analysis…' : 'Run analysis'}
          </button>

          {result && (
            <button
              type="button"
              className="secondary-button scenario-secondary-button"
              onClick={() => setActiveScreen('overview')}
            >
              Return to overview
            </button>
          )}
        </section>
      )}

      {activeScreen === 'overview' && (
        <>
          <WorkflowSteps
            activeStep={overviewStep}
            onConfigure={() => setActiveScreen('scenario')}
            onAnalyze={() => {
              if (result && !isStale) {
                setActiveScreen('accuracy')
              } else {
                setActiveScreen('scenario')
              }
            }}
            onInvestigate={() => {
              setActiveScreen(result ? 'hourly' : 'scenario')
            }}
          />

          {!result ? (
            <div className="overview-grid">
              <section className="overview-start-card">
                <p className="eyebrow">START HERE</p>
                <h2>Reconstruct a forecast decision</h2>
                <p>
                  Choose the forecast cutoff and delivery period to
                  investigate what was available to the procurement team
                  and compare it with recorded wind generation.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveScreen('scenario')}
                >
                  Configure a scenario
                </button>
                <p className="overview-supporting-note">
                  Historical data · January 2026 · All times UTC
                </p>
              </section>

              <aside className="overview-info-card">
                <p className="eyebrow">WHAT YOU'LL GET</p>
                <ul className="overview-benefit-list">
                  <li>
                    <span className="benefit-marker">01</span>
                    <span>
                      <strong>Forecast accuracy</strong>
                      <small>MAE and matched-hour coverage</small>
                    </span>
                  </li>
                  <li>
                    <span className="benefit-marker">02</span>
                    <span>
                      <strong>Deviation patterns</strong>
                      <small>Forecast compared with actual output</small>
                    </span>
                  </li>
                  <li>
                    <span className="benefit-marker">03</span>
                    <span>
                      <strong>Auditable evidence</strong>
                      <small>Publication times and hourly errors</small>
                    </span>
                  </li>
                </ul>
              </aside>
            </div>
          ) : (
            <div className={isStale ? 'results results-stale' : 'results'}>
              <div className="overview-results-heading">
                <div>
                  <p className="eyebrow">LATEST ANALYSIS</p>
                  <h2>Scenario performance</h2>
                  <p>
                    Accuracy metrics are calculated only from hours with
                    both a selected forecast and complete actual data.
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setActiveScreen('scenario')}
                >
                  Edit scenario
                </button>
              </div>

              <div className="results-overview">
                <div className="verdict">
                  <p className="eyebrow">MEAN ABSOLUTE ERROR</p>
                  <h3>
                    {result.mae === null
                      ? '—'
                      : result.mae.toLocaleString('en-GB', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    <span> MW</span>
                  </h3>
                  <p>
                    Average absolute forecast error across{' '}
                    {result.matchedPeriods} matched hours.
                  </p>
                </div>

                <div className="summary">
                  <Metric
                    label="Matched hours"
                    value={`${stats?.matchedHours ?? result.matchedPeriods} / ${stats?.expectedHours ?? '—'}`}
                    detail="Matched / expected"
                  />
                  <Metric
                    label="Data coverage"
                    value={
                      stats ? `${stats.coveragePercent.toFixed(1)}%` : '—'
                    }
                    detail="Matched delivery hours"
                  />
                  <Metric
                    label="Mean forecast"
                    value={formatMw(stats?.meanForecast ?? null)}
                  />
                  <Metric
                    label="Mean actual"
                    value={formatMw(stats?.meanActual ?? null)}
                  />
                </div>
              </div>

              <ScenarioSummary result={result} />

              <div className="overview-detail-grid">
                <section className="coverage-note">
                  <strong>Publication evidence</strong>
                  <p>
                    {selectedPublicationCount} distinct forecast
                    publication times were selected across the matched
                    delivery hours.
                  </p>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => setActiveScreen('hourly')}
                  >
                    Inspect hourly publications
                  </button>
                </section>

                <section className="coverage-note">
                  <strong>Method and coverage</strong>
                  <p>
                    MAE describes matched hours only. Missing observations
                    are excluded rather than treated as zero.
                  </p>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => setActiveScreen('methodology')}
                  >
                    Review methodology
                  </button>
                </section>
              </div>

              <WorstHoursTable rows={stats?.worstHours ?? []} />

              <div className="screen-actions">
                <button
                  type="button"
                  onClick={() => setActiveScreen('accuracy')}
                >
                  Explore accuracy chart
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setActiveScreen('hourly')}
                >
                  View all hourly data
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {activeScreen === 'accuracy' && (
        <>
          {!result ? (
            <EmptyState
              title="No analysis to chart yet"
              description="Run a scenario first. The chart will use the resulting matched forecast and actual-generation records."
              onConfigure={() => setActiveScreen('scenario')}
            />
          ) : (
            <div className={isStale ? 'results results-stale' : 'results'}>
              <ScreenHeading
                eyebrow="FORECAST PERFORMANCE"
                title="Forecast versus actual generation"
                description="Explore the shape of the forecast and recorded generation, then inspect the signed deviations."
              />
              <ScenarioSummary result={result} />
              <div className="coverage-note">
                <strong>
                  MAE: {formatMw(result.mae)} · Coverage:{' '}
                  {stats?.coveragePercent.toFixed(1) ?? '—'}%
                </strong>
                <p>
                  Error is forecast minus actual generation. Positive
                  values indicate over-forecasting; negative values
                  indicate under-forecasting.
                </p>
              </div>
              <ForecastChart
                rows={result.comparisons}
                deliveryStart={result.deliveryStart}
                deliveryEnd={result.deliveryEnd}
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => setActiveScreen('hourly')}
              >
                Inspect hourly records
              </button>
            </div>
          )}
        </>
      )}

      {activeScreen === 'hourly' && (
        <>
          {!result ? (
            <EmptyState
              title="Hourly records are not available yet"
              description="Run a scenario to load matched hourly records, publication timestamps, and forecast errors."
              onConfigure={() => setActiveScreen('scenario')}
            />
          ) : (
            <div className={isStale ? 'results results-stale' : 'results'}>
              <ScreenHeading
                eyebrow="AUDITABLE OBSERVATIONS"
                title="Hourly forecast evidence"
                description="Sort matched records to find the largest errors, compare publication lead times, or export the data."
              />
              <ScenarioSummary result={result} />
              <HourlyDataTable
                rows={result.comparisons}
                deliveryStart={result.deliveryStart}
                deliveryEnd={result.deliveryEnd}
                decisionCutoff={result.decisionCutoff}
              />
            </div>
          )}
        </>
      )}

      {activeScreen === 'methodology' && (
        <div className="results">
          <ScreenHeading
            eyebrow="TRANSPARENCY AND REPRODUCIBILITY"
            title="Data & Methodology"
            description="Understand how the historical scenario is reconstructed and how accuracy is calculated."
          />

          <section className="worst-hours-panel methodology-panel">
            <h2>Data scope</h2>
            <ul>
              <li>Geography: Great Britain national wind generation.</li>
              <li>Historical analysis period: January 2026.</li>
              <li>Forecast source: Elexon wind forecast data (WINDFOR).</li>
              <li>
                Actual generation source: Elexon FUELHH data filtered to
                wind generation.
              </li>
              <li>All scenario timestamps use UTC.</li>
            </ul>
          </section>

          <section className="worst-hours-panel methodology-panel">
            <h2>Forecast selection</h2>
            <p>
              For each delivery hour, select the latest eligible forecast
              publication whose publication timestamp is at or before
              the scenario decision cutoff.
            </p>
            <p>
              The delivery interval is start-inclusive and end-exclusive.
              The publication cutoff prevents the analysis from using
              forecast information published after the decision time.
            </p>
          </section>

          <section className="worst-hours-panel methodology-panel">
            <h2>Actual generation and coverage</h2>
            <p>
              Actual hourly generation is derived from complete pairs of
              half-hourly readings. Incomplete hourly pairs are excluded
              rather than filled with zero.
            </p>
            <p>
              Accuracy metrics use hours with both a selected forecast
              and a complete actual-generation value. Coverage is matched
              hours divided by expected delivery hours.
            </p>
          </section>

          <section className="worst-hours-panel methodology-panel">
            <h2>Accuracy metrics</h2>
            <p>
              Signed error = forecast generation minus actual generation.
            </p>
            <p>
              Absolute error = the absolute value of signed error.
              Mean absolute error (MAE) is the mean of absolute errors
              across matched hours.
            </p>
            <p>
              Positive signed error indicates over-forecasting; negative
              signed error indicates under-forecasting.
            </p>
          </section>

          <section className="worst-hours-panel methodology-panel">
            <h2>Limitations</h2>
            <ul>
              <li>This is a historical replay, not a live forecast service.</li>
              <li>
                Results do not establish financial loss, market exposure,
                or purchasing outcomes.
              </li>
              <li>
                Missing observations can affect coverage and the
                interpretation of accuracy metrics.
              </li>
              <li>
                Forecast lead time is the difference between delivery
                time and the selected publication timestamp.
              </li>
            </ul>
          </section>

          {result && <ScenarioSummary result={result} />}
        </div>
      )}
    </main>
  )
}