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

function shiftUtcDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

function buildRequest(inputs: ScenarioInputs): AnalysisRequest {
  const deliveryStart = toUtcIso(inputs.deliveryDate, inputs.startTime)
  const deliveryEnd = toUtcIso(inputs.endDate, inputs.endTime)
  const decisionCutoff = toUtcIso(inputs.cutoffDate, inputs.cutoffTime)

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
  const [inputs, setInputs] = useState<ScenarioInputs>(initialInputs)
  const [lastRunInputs, setLastRunInputs] =
    useState<ScenarioInputs | null>(null)
  const [result, setResult] = useState<AnalysisResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedHour, setSelectedHour] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const didLoad = useRef(false)

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
    if (didLoad.current) {
      return
    }

    didLoad.current = true
    void handleRun(initialInputs)

    return () => {
      abortRef.current?.abort()
    }
    // Default analysis runs once on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateInput<K extends keyof ScenarioInputs>(
    key: K,
    value: ScenarioInputs[K],
  ) {
    setInputs(current => ({ ...current, [key]: value }))
    setError(null)
  }

  function applyDayAheadPreset() {
    const cutoffDate = shiftUtcDate(inputs.deliveryDate, -1)
    const endDate = shiftUtcDate(inputs.deliveryDate, 1)

    const nextInputs: ScenarioInputs = {
      cutoffDate: cutoffDate < dates.min ? dates.min : cutoffDate,
      cutoffTime: '09:00',
      deliveryDate: inputs.deliveryDate,
      startTime: '00:00',
      endDate: endDate > dates.max ? dates.max : endDate,
      endTime: '00:00',
    }

    if (endDate > dates.max) {
      setError(
        'A 24-hour delivery day starting on 31 Jan 2026 would end on 1 Feb, which is outside the January data range. Choose an earlier delivery date.',
      )
      return
    }

    setInputs(nextInputs)
    setError(null)
  }

  function biasCopy(value: number | null): string {
    if (value === null) {
      return 'Not calculated — no matched hours'
    }

    if (value > 0) {
      return 'Mean over-forecast on matched hours'
    }

    if (value < 0) {
      return 'Mean under-forecast on matched hours'
    }

    return 'Mean signed error is zero on matched hours'
  }

  return (
    <main className="app">
      <header className="page-header">
        <p className="eyebrow">GB NATIONAL WIND · JANUARY 2026 · UTC</p>
        <h1>Day-ahead wind reconstruction</h1>
        <p>
          Reconstruct the latest Elexon wind forecast available at a decision
          cutoff and compare it with recorded national generation for the
          delivery window. This is a historical replay, not a live forecast
          or a financial assessment.
        </p>
      </header>

      <section className="decision-bar" aria-labelledby="decision-heading">
        <p className="eyebrow">DECISION CONTEXT</p>
        <h2 id="decision-heading">Define the cutoff and delivery window</h2>
        <p className="scenario-sentence">
          Using forecasts published by{' '}
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
          . Delivery end is exclusive.
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
            onClick={applyDayAheadPreset}
            disabled={loading}
          >
            Use day-ahead preset
          </button>
        </div>
      </section>

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

      {result && stats && (
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
              Accuracy figures use only hours with both a selected forecast
              and a complete actual value. Missing hours are excluded, not
              treated as zero.
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
                    : `Average |forecast − actual| across ${result.matchedPeriods} matched hours`
                }
                emphasize
              />
              <Metric
                label="Mean signed error"
                value={formatSignedMw(stats.meanSignedError)}
                detail={biasCopy(stats.meanSignedError)}
              />
              <Metric
                label="Matched hours"
                value={`${stats.matchedHours} / ${stats.expectedHours}`}
                detail="Matched / expected delivery hours"
              />
              <Metric
                label="Coverage"
                value={`${stats.coveragePercent.toFixed(1)}%`}
                detail={
                  stats.unmatchedHours === 0
                    ? 'Every expected hour has a matched comparison'
                    : `${stats.unmatchedHours} hour${stats.unmatchedHours === 1 ? '' : 's'} without a matched comparison`
                }
                emphasize={stats.unmatchedHours > 0}
              />
              <Metric
                label="Mean forecast"
                value={formatMw(stats.meanForecast)}
                detail="Average reconstructed forecast, matched hours"
              />
              <Metric
                label="Mean actual"
                value={formatMw(stats.meanActual)}
                detail="Average metered wind, matched hours"
              />
            </div>

            <section className="run-context">
              <strong>Shown reconstruction · UTC</strong>
              <p>Cutoff {formatUtc(result.decisionCutoff)}</p>
              <p>
                Delivery {formatUtc(result.deliveryStart)} to{' '}
                {formatUtc(result.deliveryEnd)}
              </p>
            </section>

            <section className="worst-hours" aria-labelledby="worst-hours-heading">
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
                  signed errors on the same hours.
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
