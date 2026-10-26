import type { KeyboardEvent } from 'react'
import type { HourlyObservation } from '../domain/analysis'
import './ForecastChart.css'

interface ForecastChartProps {
  observations: HourlyObservation[]
  selectedHour: string | null
  onSelectHour: (hour: string) => void
}

function formatHour(value: string): string {
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

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'No matched data'
  }

  return `${value.toLocaleString('en-GB', {
    maximumFractionDigits: 1,
  })} MW`
}

function formatSignedError(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '—'
  }

  const formatted = value.toLocaleString('en-GB', {
    maximumFractionDigits: 1,
  })

  return `${value > 0 ? '+' : ''}${formatted} MW`
}

function makeLine(
  observations: HourlyObservation[],
  key: 'forecastGeneration' | 'actualGeneration',
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let path = ''
  let drawing = false

  observations.forEach((point, index) => {
    const value = point[key]

    if (value === null) {
      drawing = false
      return
    }

    path += `${drawing ? 'L' : 'M'} ${x(index)} ${y(value)} `
    drawing = true
  })

  return path.trim()
}

export default function ForecastChart({
  observations,
  selectedHour,
  onSelectHour,
}: ForecastChartProps) {
  const matchedHours = observations.filter(point => point.matched).length
  const unmatchedHours = observations.length - matchedHours
  const coveragePercent =
    observations.length === 0 ? 0 : (matchedHours / observations.length) * 100

  const selectedIndex = observations.findIndex(
    point => point.startTime === selectedHour,
  )
  const selectedPoint =
    selectedIndex >= 0 ? observations[selectedIndex] : null

  if (observations.length === 0) {
    return (
      <section className="chart-panel">
        <h2>National wind, MW, by delivery hour</h2>
        <p className="chart-empty">
          The delivery window is invalid or cannot be plotted. Choose a
          valid hourly delivery window and run the analysis again.
        </p>
      </section>
    )
  }

  const chartWidth = 900
  const left = 76
  const right = 24
  const plotWidth = chartWidth - left - right
  const top = 28
  const plotHeight = 250
  const lineBottom = top + plotHeight
  const errorTop = 356
  const errorHeight = 100
  const chartHeight = 510

  const values = observations.flatMap(point =>
    [point.forecastGeneration, point.actualGeneration].filter(
      (value): value is number =>
        value !== null && Number.isFinite(value),
    ),
  )

  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(1, ...values)
  const padding = (rawMax - rawMin) * 0.08
  const minY = rawMin
  const maxY = rawMax + padding

  const errors = observations.flatMap(point =>
    point.error !== null && Number.isFinite(point.error)
      ? [point.error]
      : [],
  )

  const maxAbsError = Math.max(1, ...errors.map(Math.abs))

  const x = (index: number) =>
    left +
    (observations.length === 1
      ? plotWidth / 2
      : (index / (observations.length - 1)) * plotWidth)

  const y = (value: number) =>
    top + ((maxY - value) / (maxY - minY || 1)) * plotHeight

  const zeroY = errorTop + errorHeight / 2

  const barWidth = Math.max(
    2,
    Math.min(20, (plotWidth / observations.length) * 0.58),
  )

  const forecastPath = makeLine(observations, 'forecastGeneration', x, y)
  const actualPath = makeLine(observations, 'actualGeneration', x, y)

  const yTicks = Array.from(
    { length: 5 },
    (_, index) => minY + ((maxY - minY) * index) / 4,
  )

  const xTickIndices = Array.from(
    new Set([
      0,
      Math.floor((observations.length - 1) / 3),
      Math.floor(((observations.length - 1) * 2) / 3),
      observations.length - 1,
    ]),
  )

  function handlePointKeyDown(
    event: KeyboardEvent<SVGGElement>,
    index: number,
  ) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelectHour(observations[index].startTime)
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      const next = Math.min(index + 1, observations.length - 1)
      onSelectHour(observations[next].startTime)
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      const previous = Math.max(index - 1, 0)
      onSelectHour(observations[previous].startTime)
    }
  }

  return (
    <section className="chart-panel" aria-labelledby="forecast-chart-heading">
      <div className="chart-heading">
        <div>
          <p className="eyebrow">DELIVERY WINDOW · UTC</p>
          <h2 id="forecast-chart-heading">
            National wind, MW, by delivery hour
          </h2>
          <p className="chart-description">
            Forecast is the latest WINDFOR publication at or before cutoff.
            Actual is the hourly mean of two complete FUELHH WIND half-hours.
            The lower track is signed error (forecast − actual).
          </p>
          <p className="chart-coverage">
            {matchedHours} of {observations.length} hours matched
            {' · '}{coveragePercent.toFixed(1)}% coverage
            {unmatchedHours > 0
              ? ` · ${unmatchedHours} hour${unmatchedHours === 1 ? '' : 's'} without a matched comparison`
              : ''}
          </p>
        </div>

        <div className="chart-legend" aria-label="Chart legend">
          <span>
            <i className="legend-forecast" aria-hidden="true" />
            Forecast
          </span>
          <span>
            <i className="legend-actual" aria-hidden="true" />
            Actual
          </span>
          <span>
            <i className="legend-error" aria-hidden="true" />
            Over-forecast
          </span>
          <span>
            <i className="legend-underforecast" aria-hidden="true" />
            Under-forecast
          </span>
        </div>
      </div>

      <div
        className="chart-scroll"
        role="region"
        aria-label="Scrollable wind generation chart"
        tabIndex={0}
      >
        <svg
          className="forecast-svg"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="group"
          aria-labelledby="forecast-chart-title forecast-chart-description"
        >
          <title id="forecast-chart-title">
            Hourly forecast and actual wind generation
          </title>
          <desc id="forecast-chart-description">
            Forecast generation is shown in blue and actual generation in
            dark grey. Positive error bars indicate over-forecasting.
            Negative error bars indicate under-forecasting. Missing matched
            comparisons appear as gaps. Click an hour or use the arrow keys
            to inspect it.
          </desc>

          {yTicks.map((tick, index) => {
            const tickY = y(tick)

            return (
              <g key={index}>
                <line
                  x1={left}
                  x2={chartWidth - right}
                  y1={tickY}
                  y2={tickY}
                  className="chart-gridline"
                />
                <text
                  x={left - 10}
                  y={tickY + 4}
                  textAnchor="end"
                  className="chart-axis-label"
                >
                  {Math.round(tick).toLocaleString('en-GB')}
                </text>
              </g>
            )
          })}

          <text x={left} y={15} className="chart-axis-title">
            Generation (MW)
          </text>

          <path d={forecastPath} className="forecast-line" />
          <path d={actualPath} className="actual-line" />

          {observations.map((point, index) => (
            <g
              key={point.startTime}
              className={`chart-hour ${
                selectedIndex === index ? 'chart-hour-active' : ''
              }`}
              tabIndex={0}
              role="button"
              aria-pressed={selectedIndex === index}
              aria-label={`${formatHour(point.startTime)}. Forecast: ${formatNumber(point.forecastGeneration)}. Actual: ${formatNumber(point.actualGeneration)}. Signed error: ${formatSignedError(point.error)}.`}
              onClick={() => onSelectHour(point.startTime)}
              onKeyDown={event => handlePointKeyDown(event, index)}
            >
              <rect
                x={x(index) - Math.max(8, barWidth / 2)}
                y={top}
                width={Math.max(16, barWidth)}
                height={plotHeight + errorHeight + 80}
                fill="transparent"
                pointerEvents="all"
              />

              {point.forecastGeneration !== null && (
                <circle
                  cx={x(index)}
                  cy={y(point.forecastGeneration)}
                  r={selectedIndex === index ? 5 : 3}
                  className="forecast-point"
                  pointerEvents="none"
                />
              )}

              {point.actualGeneration !== null && (
                <circle
                  cx={x(index)}
                  cy={y(point.actualGeneration)}
                  r={selectedIndex === index ? 5 : 3}
                  className="actual-point"
                  pointerEvents="none"
                />
              )}
            </g>
          ))}

          <line
            x1={left}
            x2={chartWidth - right}
            y1={lineBottom + 20}
            y2={lineBottom + 20}
            className="chart-divider"
          />

          <text x={left} y={errorTop - 18} className="chart-axis-title">
            Signed error (MW) · forecast − actual
          </text>

          <text
            x={left - 10}
            y={zeroY - errorHeight / 2 + 4}
            textAnchor="end"
            className="chart-axis-label"
          >
            +{maxAbsError.toLocaleString('en-GB', {
              maximumFractionDigits: 0,
            })}
          </text>

          <text
            x={left - 10}
            y={zeroY + errorHeight / 2 + 4}
            textAnchor="end"
            className="chart-axis-label"
          >
            −{maxAbsError.toLocaleString('en-GB', {
              maximumFractionDigits: 0,
            })}
          </text>

          <line
            x1={left}
            x2={chartWidth - right}
            y1={zeroY}
            y2={zeroY}
            className="chart-zero-line"
          />

          {observations.map((point, index) => {
            if (point.error === null) {
              return (
                <text
                  key={point.startTime}
                  x={x(index)}
                  y={zeroY - 7}
                  textAnchor="middle"
                  className="chart-missing-mark"
                  aria-label={`${formatHour(point.startTime)}: no matched comparison`}
                >
                  ×
                </text>
              )
            }

            const height =
              (Math.abs(point.error) / maxAbsError) *
              (errorHeight / 2 - 5)

            const isOverForecast = point.error > 0
            const rectY = isOverForecast ? zeroY - height : zeroY

            return (
              <rect
                key={point.startTime}
                x={x(index) - barWidth / 2}
                y={rectY}
                width={barWidth}
                height={Math.max(1, height)}
                rx={2}
                className={
                  isOverForecast
                    ? 'error-bar error-bar-positive'
                    : point.error < 0
                      ? 'error-bar error-bar-negative'
                      : 'error-bar error-bar-neutral'
                }
                pointerEvents="none"
              />
            )
          })}

          {xTickIndices.map(index => (
            <text
              key={observations[index].startTime}
              x={x(index)}
              y={chartHeight - 12}
              textAnchor={
                index === 0
                  ? 'start'
                  : index === observations.length - 1
                    ? 'end'
                    : 'middle'
              }
              className="chart-axis-label"
            >
              {formatHour(observations[index].startTime)}
            </text>
          ))}
        </svg>
      </div>

      {selectedPoint ? (
        <div className="chart-tooltip" role="status" aria-live="polite">
          <div className="chart-tooltip-heading">
            <strong>{formatHour(selectedPoint.startTime)}</strong>
            <span>
              {selectedPoint.error === null
                ? 'No matched comparison'
                : selectedPoint.error > 0
                  ? 'Over-forecast'
                  : selectedPoint.error < 0
                    ? 'Under-forecast'
                    : 'Exact match'}
            </span>
          </div>

          <div className="chart-tooltip-grid">
            <div>
              <span>Forecast</span>
              <strong>{formatNumber(selectedPoint.forecastGeneration)}</strong>
            </div>
            <div>
              <span>Actual</span>
              <strong>{formatNumber(selectedPoint.actualGeneration)}</strong>
            </div>
            <div>
              <span>Signed error</span>
              <strong>{formatSignedError(selectedPoint.error)}</strong>
            </div>
            <div>
              <span>Forecast published</span>
              <strong>
                {selectedPoint.publishTime
                  ? formatHour(selectedPoint.publishTime)
                  : 'No matched data'}
              </strong>
            </div>
            <div>
              <span>Lead time</span>
              <strong>
                {selectedPoint.leadTimeHours === null
                  ? '—'
                  : `${selectedPoint.leadTimeHours.toFixed(1)} h`}
              </strong>
            </div>
          </div>

          <p className="chart-tooltip-explanation">
            {selectedPoint.error === null
              ? 'This delivery hour has no matched forecast-and-actual pair. The analysis does not identify which source is missing.'
              : selectedPoint.error > 0
                ? 'Forecast generation was higher than actual generation for this hour.'
                : selectedPoint.error < 0
                  ? 'Actual generation was higher than forecast generation for this hour.'
                  : 'Forecast and actual generation were equal for this hour.'}
          </p>
        </div>
      ) : (
        <p className="chart-select-hint">
          Select a delivery hour on the chart or in the table to inspect
          forecast, actual, error, publication time, and lead time.
        </p>
      )}

      <p className="chart-footnote">
        Positive error means generation was over-forecast. Negative error
        means actual generation exceeded the forecast. Missing hours are
        shown as gaps and are excluded from matched-hour accuracy metrics.
      </p>
    </section>
  )
}
