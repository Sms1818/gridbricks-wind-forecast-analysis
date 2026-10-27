
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AnalysisApiError,
  runAnalysis,
} from './api/analysisApi'
import {
  PUBLICATION_LOOKBACK_HOURS,
  getAnalysisStats,
  getHourlyObservations,
  getPublicationWindow,
  getSettlementRange,
  type AnalysisRequest,
  type AnalysisResponse,
} from './domain/analysis'
import ForecastChart from './components/ForecastChart'
import HourlyTable from './components/HourlyTable'
import GreatBritainVisual from './components/GreatBritainVisual'
import './App.css'

interface ScenarioInputs {
  cutoffDate: string
  cutoffTime: string
  deliveryDate: string
  startTime: string
  endDate: string
  endTime: string
}

const initialInputs: ScenarioInputs = {
  cutoffDate: '',
  cutoffTime: '',
  deliveryDate: '',
  startTime: '',
  endDate: '',
  endTime: '',
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
  if (!value) return 'Not set'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return 'Not set'
  }
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date) + ' UTC'
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

function formatSignedMw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '—'
  }

  const formatted = value.toLocaleString('en-GB', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })

  return `${value > 0 ? '+' : ''}${formatted} MW`
}

function compareForecastsByHour(
  earlier: AnalysisResponse,
  later: AnalysisResponse,
): { changed: number; unchanged: number; unavailable: number } {
  type LatestValue = { publishTime: number; generation: number | null }
  const latestByHour = (response: AnalysisResponse) => {
    const latest = new Map<number, LatestValue>()
    for (const publication of response.publicationTimeline ?? []) {
      const publishTime = Date.parse(publication.publishTime)
      const deliveryHour = Date.parse(publication.startTime)
      const existing = latest.get(deliveryHour)
      if (!existing || publishTime > existing.publishTime) {
        latest.set(deliveryHour, {
          publishTime,
          generation: publication.forecastGeneration,
        })
      } else if (publishTime === existing.publishTime &&
        publication.forecastGeneration !== existing.generation) {
        // Conflicting values in the latest publication are not comparable.
        existing.generation = null
      }
    }
    return latest
  }

  const earlierLatest = latestByHour(earlier)
  const laterLatest = latestByHour(later)
  let changed = 0
  let unchanged = 0
  let unavailable = 0
  const start = Date.parse(earlier.deliveryStart)
  const end = Date.parse(earlier.deliveryEnd)
  const hourMs = 60 * 60 * 1000

  for (let hour = start; hour < end; hour += hourMs) {
    const first = earlierLatest.get(hour)
    const second = laterLatest.get(hour)
    if (!first || !second || first.generation === null || second.generation === null) {
      unavailable++
    } else if (first.generation !== second.generation) {
      changed++
    } else {
      unchanged++
    }
  }
  return { changed, unchanged, unavailable }
}


function buildRequest(inputs: ScenarioInputs): AnalysisRequest {
  // Validate the form before constructing timestamps. Empty fields otherwise
  // become strings such as "T:00:00Z", which are not valid ISO timestamps.
  if (
    !inputs.cutoffDate ||
    !inputs.cutoffTime ||
    !inputs.deliveryDate ||
    !inputs.startTime ||
    !inputs.endDate ||
    !inputs.endTime
  ) {
    throw new Error(
      'Complete all cutoff and delivery date/time fields before running the analysis.',
    )
  }

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

  const deliveryStart = toUtcIso(inputs.deliveryDate, inputs.startTime)
  const deliveryEnd = toUtcIso(inputs.endDate, inputs.endTime)
  const decisionCutoff = toUtcIso(inputs.cutoffDate, inputs.cutoffTime)
  const deliveryStartMs = Date.parse(deliveryStart)
  const deliveryEndMs = Date.parse(deliveryEnd)
  const cutoffMs = Date.parse(decisionCutoff)

  if (
    !Number.isFinite(deliveryStartMs) ||
    !Number.isFinite(deliveryEndMs) ||
    !Number.isFinite(cutoffMs)
  ) {
    throw new Error('Enter valid dates and times for the cutoff and delivery window.')
  }

  if (deliveryEndMs <= deliveryStartMs) {
    throw new Error('Delivery end must be after delivery start.')
  }

  const durationHours =
    (Date.parse(deliveryEnd) - Date.parse(deliveryStart)) /
    (60 * 60 * 1000)

  if (durationHours > 168) {
    throw new Error('The delivery window cannot exceed 7 days.')
  }

  const publication = getPublicationWindow(deliveryStart, decisionCutoff)
  const settlement = getSettlementRange(deliveryStart, deliveryEnd)

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
        <option value="">Select time</option>
        {options.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}

function Metric({
  label,
  value,
  detail,
  emphasize = false,
}: {
  label: string
  value: string
  detail: string
  emphasize?: boolean
}) {
  return (
    <div className={`metric ${emphasize ? 'metric-emphasis' : ''}`}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<"setup" | "results">("setup")

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [screen])
  const [inputs, setInputs] = useState<ScenarioInputs>(initialInputs)
  const [lastRunInputs, setLastRunInputs] =
    useState<ScenarioInputs | null>(null)
  const [result, setResult] = useState<AnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [presetMessage, setPresetMessage] = useState<string | null>(null)
  const [selectedHour, setSelectedHour] = useState<string | null>(null)
  const [comparisonCutoff, setComparisonCutoff] = useState('')
  const [comparisonResult, setComparisonResult] =
    useState<AnalysisResponse | null>(null)
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [comparisonError, setComparisonError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  const isStale =
    result !== null &&
    lastRunInputs !== null &&
    JSON.stringify(inputs) !== JSON.stringify(lastRunInputs)

  const stats = result ? getAnalysisStats(result) : null

  const observations = useMemo(() => {
    if (!result) {
      return []
    }

    return getHourlyObservations(
      result.deliveryStart,
      result.deliveryEnd,
      result.comparisons,
    )
  }, [result])

  async function handleRun(nextInputs: ScenarioInputs = inputs) {
    abortRef.current?.abort()

    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)

    try {
      const request = buildRequest(nextInputs)
      const data = await runAnalysis(request, controller.signal)

      setResult(data)
      setLastRunInputs({ ...nextInputs })
      setSelectedHour(null)
      setScreen('results')
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }

      setError(
        err instanceof AnalysisApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong while running the analysis.',
      )
    } finally {
      if (abortRef.current === controller) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  async function handleCompareCutoffs() {
    if (!result || !lastRunInputs || !comparisonCutoff) return

    const primaryCutoff = Date.parse(result.decisionCutoff)
    const alternateCutoff = Date.parse(comparisonCutoff)

    if (!Number.isFinite(alternateCutoff) || alternateCutoff === primaryCutoff) {
      setComparisonError('Choose a different valid decision cutoff.')
      return
    }

    if (alternateCutoff > primaryCutoff) {
      setComparisonError(
        'The comparison cutoff must be earlier than the primary cutoff.'
      )
      return
    }

    setComparisonLoading(true)
    setComparisonError(null)
    setComparisonResult(null)

    try {
      const request = buildRequest({
        ...lastRunInputs,
        cutoffDate: comparisonCutoff.slice(0, 10),
        cutoffTime: comparisonCutoff.slice(11, 16),
      })
      const data = await runAnalysis(request)
      setComparisonResult(data)
    } catch (err) {
      setComparisonError(
        err instanceof Error ? err.message : 'Could not compare scenarios.'
      )
    } finally {
      setComparisonLoading(false)
    }
  }

  function resetInputs() {
    setInputs({
      cutoffDate: '',
      cutoffTime: '',
      deliveryDate: '',
      startTime: '',
      endDate: '',
      endTime: '',
    })

    setError(null)
    setPresetMessage(null)
  }

  function updateInput<K extends keyof ScenarioInputs>(
    key: K,
    value: ScenarioInputs[K],
  ) {
    setInputs(current => ({ ...current, [key]: value }))
    setError(null)
    setPresetMessage(null)
  }

  function biasCopy(value: number | null): string {
    if (value === null) {
      return 'Not calculated — no matched hours'
    }

    if (value > 0) {
      return 'Positive bias: forecasts are higher than actual generation on average'
    }

    if (value < 0) {
      return 'Negative bias: forecasts are lower than actual generation on average'
    }

    return 'Forecast and actual generation balance on average across matched hours'
  }

  return (
    <main className="app">
      {screen === 'setup' && (
        <header className="page-header">
          <nav className="brand-bar" aria-label="Product navigation">
            <a
              className="brand-lockup"
              href="#main-analysis"
              aria-label="GridBricks Wind Forecast Review"
            >
              <span className="brand-mark" aria-hidden="true">G</span>
              <span className="brand-name">GridBricks</span>
            </a>

            <span className="brand-divider" aria-hidden="true" />
            <span className="brand-product">Wind Forecast Review</span>

            <div className="brand-meta">
              <span>GB National Wind</span>
              <span>All times UTC</span>
            </div>
          </nav>

          <div className="hero-content">
            <div className="hero-copy">
              <p className="eyebrow">
                DAY-AHEAD WIND ANALYSIS
              </p>

              <h1>
                Understand the forecast.<br />
                <span>Evaluate the decision.</span>
              </h1>

              <p className="hero-description">Compare the wind-power forecast available at decision time with the electricity actually generated, and see how far apart they were.</p>

              <div className="hero-footnote">
                <span className="hero-status-dot" />
                HISTORICAL ANALYSIS · GREAT BRITAIN
              </div>
            </div>

            <GreatBritainVisual />
          </div>
        </header>
      )}

      {screen === 'setup' && (
        <section
          id="main-analysis"
          className="decision-bar"
          aria-labelledby="decision-heading"
        >
          <p className="eyebrow">DECISION CONTEXT</p>
          <h2 id="decision-heading">Define the cutoff and delivery window</h2>

          <p className="scenario-sentence">
            Comparing forecasts available by{' '}
            <strong>
              {formatUtc(toUtcIso(inputs.cutoffDate, inputs.cutoffTime))}
            </strong>{' '}
            against actual generation for{' '}
            <strong>
              {formatUtc(toUtcIso(inputs.deliveryDate, inputs.startTime))}
            </strong>{' '}
            through{' '}
            <strong>
              {formatUtc(toUtcIso(inputs.endDate, inputs.endTime))}
            </strong>
            . The delivery end time is exclusive.
          </p>

          <div className="controls">
            <div className="control-group">
              <h3>Decision cutoff</h3>
              <p className="field-help">
                Latest publication time eligible for the reconstructed forecast.
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
                Hours to compare with recorded wind generation. Maximum: seven days.
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

          {presetMessage && (
            <p className="preset-feedback" role="status" aria-live="polite">
              {presetMessage}
            </p>
          )}

          <div className="decision-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void handleRun()}
              disabled={loading}
            >
              {loading ? 'Running analysis…' : 'Run analysis'}
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={resetInputs}
              disabled={loading}
            >
              Reset all fields
            </button>
          </div>
        </section>
      )}

      {error && (
        <section className="error" role="alert">
          <strong>Analysis could not be completed</strong>
          <p>{error}</p>
          {result ? (
            <p>The last successful reconstruction is still shown below.</p>
          ) : (
            <p>Review the cutoff and delivery window, then try again.</p>
          )}
        </section>
      )}

      {loading && (
        <p className="status-line" role="status" aria-live="polite">
          Fetching forecast and actual-generation data…
        </p>
      )}

      {isStale && (
        <p className="stale-notice" role="status">
          Inputs have changed. The timeline still belongs to the previous run.
          Run the analysis again to update it.
        </p>
      )}

      {loading && !result && (
        <section className="chart-skeleton" aria-hidden="true">
          <div className="skeleton-line wide" />
          <div className="skeleton-plot" />
          <div className="skeleton-line" />
        </section>
      )}

      {screen === 'results' && (
        <header className="results-topbar">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen('setup')}
          >
            <span aria-hidden="true">←</span>
            Back to setup
          </button>

          <div className="results-brand">
            <span className="results-brand-mark" aria-hidden="true">G</span>
            <span>GRIDBRICKS / WIND REVIEW</span>
          </div>

          <span className="results-status">ANALYSIS COMPLETE</span>
        </header>
      )}

      {screen === 'results' && result && stats && (
        <div className={isStale || loading ? 'workspace is-muted' : 'workspace'}>
          <div className="workspace-main">
            <ForecastChart
              observations={observations}
              selectedHour={selectedHour}
              onSelectHour={setSelectedHour}
            />
          </div>

          <aside className="metrics-panel" aria-label="Accuracy summary">
            <p className="eyebrow">QUANTIFIED ERROR</p>
            <h2>Matched-hour summary</h2>
            <p className="metrics-intro">
              MAE is the average size of forecast errors, ignoring their
              direction. Mean signed error shows whether forecasts tend to be
              too high or too low. Coverage shows how many expected hours
              have a valid comparison. All accuracy metrics use matched hours
              only; missing hours are excluded, never treated as zero.
            </p>

            <div className="metrics-grid">
              <Metric
                label="Mean absolute error"
                value={
                  result.mae === null
                    ? 'Not calculated'
                    : `${result.mae.toLocaleString('en-GB', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })} MW`
                }
                detail={
                  result.mae === null
                    ? 'No matched hours — accuracy is not calculated'
                    : `Average absolute forecast error across ${result.matchedPeriods} matched hours; lower is better`
                }
                emphasize
              />

              <Metric
                label="Root mean squared error"
                value={
                  result.rmse === null
                    ? 'Not calculated'
                    : `${result.rmse.toLocaleString('en-GB', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })} MW`
                }
                detail={
                  result.rmse === null
                    ? 'No matched hours — accuracy is not calculated'
                    : 'Penalizes larger forecast errors more heavily; lower is better'
                }
              />

              <Metric
                label="Mean signed error"
                value={formatSignedMw(stats.meanSignedError)}
                detail={biasCopy(stats.meanSignedError)}
              />

              <Metric
                label="Matched hours"
                value={`${stats.matchedHours} / ${stats.expectedHours}`}
                detail="Valid forecast-and-actual pairs / all expected hours"
              />

              <Metric
                label="Coverage"
                value={`${stats.coveragePercent.toFixed(1)}%`}
                detail={
                  stats.unmatchedHours === 0
                    ? '100% coverage: every expected hour has a valid comparison'
                    : `${stats.unmatchedHours} hour${stats.unmatchedHours === 1 ? '' : 's'} without a matched comparison`
                }
                emphasize={stats.unmatchedHours > 0}
              />

              <Metric
                label="Mean forecast"
                value={formatMw(stats.meanForecast)}
                detail="Average predicted wind generation across matched hours"
              />

              <Metric
                label="Mean actual"
                value={formatMw(stats.meanActual)}
                detail="Average actual wind generation across matched hours"
              />
            </div>

            <section
              className="data-quality"
              aria-labelledby="data-quality-heading"
            >
              <p className="eyebrow">DATA COMPLETENESS</p>
              <h3 id="data-quality-heading">Data-quality diagnostics</h3>
              <p className="data-quality-intro">
                These counts describe different data issues and may overlap.
                Missing or ambiguous data is excluded from accuracy calculations,
                not replaced with zero.
              </p>

              <dl className="quality-grid">
                <div className="quality-item">
                  <dt>Expected hours</dt>
                  <dd>{result.expectedHours}</dd>
                  <p>Total delivery hours requested.</p>
                </div>
                <div className="quality-item">
                  <dt>Missing forecasts</dt>
                  <dd>{result.missingForecastHours}</dd>
                  <p>No unambiguous eligible forecast was available.</p>
                </div>
                <div className="quality-item">
                  <dt>Incomplete actuals</dt>
                  <dd>{result.incompleteActualHours}</dd>
                  <p>At least one required half-hour reading is missing.</p>
                </div>
                <div className="quality-item">
                  <dt>Ambiguous actuals</dt>
                  <dd>{result.ambiguousActualHours}</dd>
                  <p>A half-hour timestamp has duplicate readings.</p>
                </div>
                <div className="quality-item">
                  <dt>Conflicting forecasts</dt>
                  <dd>{result.conflictingForecastHours}</dd>
                  <p>The latest eligible publication has conflicting values.</p>
                </div>
              </dl>
            </section>

            <section className="run-context">
              <strong>Shown reconstruction · UTC</strong>
              <p>Cutoff {formatUtc(result.decisionCutoff)}</p>
              <p>
                Delivery {formatUtc(result.deliveryStart)} to{' '}
                {formatUtc(result.deliveryEnd)}
              </p>
            </section>

            <section className="scenario-comparison" aria-labelledby="scenario-heading">
              <p className="eyebrow">DECISION COMPARISON</p>
              <h3 id="scenario-heading">Compare earlier decision cutoff</h3>
              <p className="data-quality-intro">
                Compare forecast accuracy for the same delivery window using only
                information available at each cutoff. Historical accuracy does not
                guarantee future procurement outcomes.
              </p>
              <div className="scenario-controls">
                <label className="field">
                  <span>Earlier cutoff date (UTC)</span>
                  <input
                    type="date"
                    min="2026-01-01"
                    max={result.decisionCutoff.slice(0, 10)}
                    value={comparisonCutoff.slice(0, 10)}
                    onChange={event => {
                      const date = event.target.value
                      const time = comparisonCutoff.slice(11, 16) || "00:00"
                      setComparisonCutoff(date ? `${date}T${time}` : "")
                      setComparisonResult(null)
                      setComparisonError(null)
                    }}
                  />
                </label>
                <label className="field">
                  <span>Earlier cutoff time (UTC)</span>
                  <input
                    type="time"
                    step="1800"
                    value={comparisonCutoff.slice(11, 16)}
                    onChange={event => {
                      const time = event.target.value
                      const date = comparisonCutoff.slice(0, 10)
                      setComparisonCutoff(date && time ? `${date}T${time}` : "")
                      setComparisonResult(null)
                      setComparisonError(null)
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleCompareCutoffs}
                  disabled={!comparisonCutoff || comparisonLoading}
                >
                  {comparisonLoading ? 'Comparing…' : 'Compare cutoffs'}
                </button>
              </div>
              {comparisonError && <p role="alert" className="empty-copy">{comparisonError}</p>}
              {comparisonResult && (
                <div className="scenario-grid">
                  <div className="scenario-card">
                    <strong>Earlier · {formatUtc(comparisonResult.decisionCutoff)}</strong>
                    <p>
                      MAE: {comparisonResult.mae === null
                        ? 'Unavailable'
                        : formatMw(comparisonResult.mae)}
                    </p>
                    <p>
                      RMSE: {comparisonResult.rmse === null
                        ? 'Unavailable'
                        : formatMw(comparisonResult.rmse)}
                    </p>
                    <p>
                      Matched hours: {comparisonResult.matchedPeriods}/{comparisonResult.expectedHours}
                      ({comparisonResult.expectedHours > 0
                        ? (comparisonResult.matchedPeriods / comparisonResult.expectedHours * 100).toFixed(1)
                        : '0.0'}% coverage)
                    </p>
                    {comparisonResult.matchedPeriods === 0 && (
                      <p className="scenario-warning">
                        Insufficient matched data to calculate accuracy.
                      </p>
                    )}
                  </div>
                  <div className="scenario-card">
                    <strong>Later · {formatUtc(result.decisionCutoff)}</strong>
                    <p>
                      MAE: {result.mae === null ? 'Unavailable' : formatMw(result.mae)}
                    </p>
                    <p>
                      RMSE: {result.rmse === null ? 'Unavailable' : formatMw(result.rmse)}
                    </p>
                    <p>
                      Matched hours: {result.matchedPeriods}/{result.expectedHours}
                      ({result.expectedHours > 0
                        ? (result.matchedPeriods / result.expectedHours * 100).toFixed(1)
                        : '0.0'}% coverage)
                    </p>
                    {result.matchedPeriods === 0 && (
                      <p className="scenario-warning">
                        Insufficient matched data to calculate accuracy.
                      </p>
                    )}
                  </div>
                  <p className="scenario-delta">
                    {comparisonResult.mae !== null && result.mae !== null ? (
                      <>
                        MAE {result.mae < comparisonResult.mae ? 'improved' : result.mae > comparisonResult.mae ? 'increased' : 'was unchanged'} by {formatMw(Math.abs(comparisonResult.mae - result.mae))}
                        ({comparisonResult.mae === 0 ? 'baseline MAE is zero' : `${(Math.abs(comparisonResult.mae - result.mae) / comparisonResult.mae * 100).toFixed(1)}%`}).{' '}
                      </>
                    ) : 'MAE delta unavailable because one or both scenarios have no matched-hour metric. '}
                    {comparisonResult.rmse !== null && result.rmse !== null ? (
                      <>
                        RMSE {result.rmse < comparisonResult.rmse ? 'improved' : result.rmse > comparisonResult.rmse ? 'increased' : 'was unchanged'} by {formatMw(Math.abs(comparisonResult.rmse - result.rmse))}
                        ({comparisonResult.rmse === 0 ? 'baseline RMSE is zero' : `${(Math.abs(comparisonResult.rmse - result.rmse) / comparisonResult.rmse * 100).toFixed(1)}%`}).{' '}
                      </>
                    ) : 'RMSE delta unavailable because one or both scenarios have no matched-hour metric. '}
                    Forecast comparison: {
                      (() => {
                        const counts = compareForecastsByHour(comparisonResult, result)
                        return `${counts.changed} changed, ${counts.unchanged} unchanged, ${counts.unavailable} unavailable or ambiguous`
                      })()
                    }. Metrics are calculated independently over each scenario's matched hours.
                    {comparisonResult.matchedPeriods !== result.matchedPeriods &&
                      ' Matched-hour counts differ, so the accuracy metrics are not a strict like-for-like comparison.'}
                  </p>
                </div>
              )}
            </section>

            <section
              className="worst-hours"
              aria-labelledby="worst-hours-heading"
            >
              <h3 id="worst-hours-heading">Largest absolute errors</h3>

              {stats.worstHours.length === 0 ? (
                <p className="empty-copy">
                  No matched hours are available to rank.
                </p>
              ) : (
                <ul>
                  {stats.worstHours.map(row => (
                    <li key={row.startTime}>
                      <button
                        type="button"
                        className={
                          selectedHour === row.startTime
                            ? 'worst-hour is-selected'
                            : 'worst-hour'
                        }
                        onClick={() => setSelectedHour(row.startTime)}
                      >
                        <span>{formatUtc(row.startTime)}</span>
                        <strong
                          className={
                            row.error > 0
                              ? 'error-positive'
                              : row.error < 0
                                ? 'error-negative'
                                : ''
                          }
                        >
                          {formatSignedMw(row.error)}
                        </strong>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <p className="footnote">
                Ranked by absolute error. These are observed MW differences,
                not estimates of financial loss.
              </p>
            </section>

            <details className="methodology">
              <summary>How these numbers are calculated</summary>
              <div>
                <p>
                  Geography: Great Britain national wind. Sources: Elexon
                  WINDFOR forecasts and FUELHH actuals filtered to WIND.
                  Scope: purchase decisions in January 2026. All times UTC.
                </p>
                <p>
                  For each delivery hour, the analysis selects the latest
                  eligible forecast publication at or before the cutoff.
                  Forecasts published after the cutoff are excluded.
                </p>
                <p>
                  Actual hourly generation is the mean of exactly one :00 and
                  one :30 FUELHH reading. Incomplete pairs are excluded
                  rather than filled with zero.
                </p>
                <p>
                  Signed error = forecast − actual. Absolute error is the
                  absolute value of signed error. MAE is the mean of absolute
                  errors on matched hours. Mean signed error is the mean of
                  signed errors on the same hours. RMSE is the square root
                  of the mean squared signed error, so larger errors receive
                  more weight.
                </p>
                <p>
                  Forecast publications are requested from{' '}
                  {PUBLICATION_LOOKBACK_HOURS} hours before delivery start
                  (or before the cutoff when delivery is further ahead)
                  through the cutoff, so the latest eligible WINDFOR
                  publication is not dropped by a shorter fetch window.
                </p>
                <p>
                  This replay does not estimate imbalance cost, market
                  exposure, or the utility’s own generation.
                </p>
              </div>
            </details>
          </aside>

          <div className="workspace-evidence">
            {stats.matchedHours === 0 && (
              <section className="zero-match" role="status">
                <strong>No matched hours</strong>
                <p>
                  Accuracy is not calculated for this window. The timeline
                  still shows every expected delivery hour as a coverage gap.
                </p>
              </section>
            )}

            <HourlyTable
              observations={observations}
              selectedHour={selectedHour}
              decisionCutoff={result.decisionCutoff}
              onSelectHour={setSelectedHour}
            />
          </div>
        </div>
      )}
    </main>
  )
}
