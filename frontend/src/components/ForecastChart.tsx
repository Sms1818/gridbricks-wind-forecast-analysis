import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ForecastComparison } from '../domain/analysis'
import './ForecastChart.css'

interface ForecastChartProps {
    rows: ForecastComparison[]
    deliveryStart: string
    deliveryEnd: string
}

interface ChartPoint {
    time: number
    label: string
    forecast: number | null
    actual: number | null
    error: number | null
    publishTime: string | null
}

const HOUR_MS = 60 * 60 * 1000

function formatHour(timestamp: number): string {
    return (
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'UTC',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(timestamp)) + ' UTC'
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

function formatUtcPublication(value: string): string {
    const timestamp = Date.parse(value)

    return Number.isFinite(timestamp)
        ? formatHour(timestamp)
        : 'Unknown publication time'
}

function buildPoints(
    rows: ForecastComparison[],
    deliveryStart: string,
    deliveryEnd: string,
): ChartPoint[] {
    const start = Date.parse(deliveryStart)
    const end = Date.parse(deliveryEnd)

    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        (end - start) % HOUR_MS !== 0
    ) {
        return []
    }

    const rowsByTime = new Map<number, ForecastComparison>()

    for (const row of rows) {
        const timestamp = Date.parse(row.startTime)

        if (
            !Number.isFinite(timestamp) ||
            timestamp < start ||
            timestamp >= end
        ) {
            continue
        }

        rowsByTime.set(timestamp, row)
    }

    const points: ChartPoint[] = []

    for (let time = start; time < end; time += HOUR_MS) {
        const row = rowsByTime.get(time)

        const forecast =
            row && Number.isFinite(row.forecastGeneration)
                ? row.forecastGeneration
                : null

        const actual =
            row && Number.isFinite(row.actualGeneration)
                ? row.actualGeneration
                : null

        const error =
            forecast !== null && actual !== null
                ? forecast - actual
                : null

        points.push({
            time,
            label: formatHour(time),
            forecast,
            actual,
            error,
            publishTime: row?.publishTime ?? null,
        })
    }

    return points
}

function makeLine(
    points: ChartPoint[],
    key: 'forecast' | 'actual',
    x: (index: number) => number,
    y: (value: number) => number,
): string {
    let path = ''
    let drawing = false

    points.forEach((point, index) => {
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
    rows,
    deliveryStart,
    deliveryEnd,
}: ForecastChartProps) {
    const [activeIndex, setActiveIndex] = useState<number | null>(null)

    const points = buildPoints(rows, deliveryStart, deliveryEnd)

    const matchedHours = points.filter(
        point => point.forecast !== null && point.actual !== null,
    ).length

    const forecastHours = points.filter(
        point => point.forecast !== null,
    ).length

    const actualHours = points.filter(
        point => point.actual !== null,
    ).length

    const coveragePercent =
        points.length === 0 ? 0 : (matchedHours / points.length) * 100

    const activePoint =
        activeIndex === null ? null : points[activeIndex] ?? null

    if (points.length === 0) {
        return (
            <section className="chart-panel">
                <h2>Forecast vs actual generation</h2>
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

    const values = points.flatMap(point =>
        [point.forecast, point.actual].filter(
            (value): value is number =>
                value !== null && Number.isFinite(value),
        ),
    )

    const rawMin = Math.min(0, ...values)
    const rawMax = Math.max(1, ...values)
    const padding = (rawMax - rawMin) * 0.08
    const minY = rawMin
    const maxY = rawMax + padding

    const errors = points.flatMap(point =>
        point.error !== null && Number.isFinite(point.error)
            ? [point.error]
            : [],
    )

    const maxAbsError = Math.max(1, ...errors.map(Math.abs))

    const x = (index: number) =>
        left +
        (points.length === 1
            ? plotWidth / 2
            : (index / (points.length - 1)) * plotWidth)

    const y = (value: number) =>
        top + ((maxY - value) / (maxY - minY || 1)) * plotHeight

    const zeroY = errorTop + errorHeight / 2

    const barWidth = Math.max(
        2,
        Math.min(20, (plotWidth / points.length) * 0.58),
    )

    const forecastPath = makeLine(points, 'forecast', x, y)
    const actualPath = makeLine(points, 'actual', x, y)

    const yTicks = Array.from(
        { length: 5 },
        (_, index) => minY + ((maxY - minY) * index) / 4,
    )

    const xTickIndices = Array.from(
        new Set([
            0,
            Math.floor((points.length - 1) / 3),
            Math.floor(((points.length - 1) * 2) / 3),
            points.length - 1,
        ]),
    )

    function activatePoint(index: number) {
        setActiveIndex(index)
    }

    function handlePointKeyDown(
        event: KeyboardEvent<SVGGElement>,
        index: number,
    ) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setActiveIndex(current => current === index ? null : index)
        }

        if (event.key === 'Escape') {
            setActiveIndex(null)
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault()
            setActiveIndex(Math.min(index + 1, points.length - 1))
        }

        if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setActiveIndex(Math.max(index - 1, 0))
        }
    }

    return (
        <section className="chart-panel" aria-labelledby="forecast-chart-heading">
            <div className="chart-heading">
                <div>
                    <p className="eyebrow">DELIVERY WINDOW · UTC</p>
                    <h2 id="forecast-chart-heading">
                        Forecast vs actual generation
                    </h2>
                    <p className="chart-description">
                        Compare hourly forecast generation with recorded generation.
                        The lower chart shows the signed difference between them.
                    </p>
                    <p className="chart-coverage">
                        {matchedHours} of {points.length} hours matched
                        {' · '}{coveragePercent.toFixed(1)}% coverage
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

            <div className="chart-coverage-details">
                <span>
                    Forecast available: <strong>{forecastHours}/{points.length}</strong>
                </span>
                <span>
                    Actual available: <strong>{actualHours}/{points.length}</strong>
                </span>
                <span>
                    Matched pairs: <strong>{matchedHours}/{points.length}</strong>
                </span>
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
                        Negative error bars indicate under-forecasting. Missing values
                        appear as gaps. Focus an hour and use the arrow keys to inspect
                        its data. Press Enter or Space to pin its details.
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

                    {points.map((point, index) => (
                        <g
                            key={point.time}
                            className={`chart-hour ${activeIndex === index ? 'chart-hour-active' : ''
                                }`}
                            tabIndex={0}
                            role="button"
                            aria-pressed={activeIndex === index}
                            aria-label={`${point.label}. Forecast: ${formatNumber(point.forecast)}. Actual: ${formatNumber(point.actual)}. Signed error: ${formatSignedError(point.error)}.`}
                            onMouseEnter={() => activatePoint(index)}
                            onMouseLeave={() =>
                                setActiveIndex(current =>
                                    current === index ? null : current,
                                )
                            }
                            onFocus={() => activatePoint(index)}
                            onBlur={() =>
                                setActiveIndex(current =>
                                    current === index ? null : current,
                                )
                            }
                            onKeyDown={event => handlePointKeyDown(event, index)}
                        >
                            <rect
                                x={x(index) - Math.max(8, barWidth / 2)}
                                y={top}
                                width={Math.max(16, barWidth)}
                                height={plotHeight}
                                fill="transparent"
                                pointerEvents="all"
                            />

                            {point.forecast !== null && (
                                <circle
                                    cx={x(index)}
                                    cy={y(point.forecast)}
                                    r={activeIndex === index ? 5 : 3}
                                    className="forecast-point"
                                    pointerEvents="none"
                                />
                            )}

                            {point.actual !== null && (
                                <circle
                                    cx={x(index)}
                                    cy={y(point.actual)}
                                    r={activeIndex === index ? 5 : 3}
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

                    {points.map((point, index) => {
                        if (point.error === null) {
                            return (
                                <text
                                    key={point.time}
                                    x={x(index)}
                                    y={zeroY - 7}
                                    textAnchor="middle"
                                    className="chart-missing-mark"
                                    aria-label={`${point.label}: no matched error data`}
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
                                key={point.time}
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
                            key={points[index].time}
                            x={x(index)}
                            y={chartHeight - 12}
                            textAnchor={
                                index === 0
                                    ? 'start'
                                    : index === points.length - 1
                                        ? 'end'
                                        : 'middle'
                            }
                            className="chart-axis-label"
                        >
                            {formatHour(points[index].time)}
                        </text>
                    ))}
                </svg>
            </div>

            {activePoint && (
                <div className="chart-tooltip" role="status" aria-live="polite">
                    <div className="chart-tooltip-heading">
                        <strong>{activePoint.label}</strong>
                        <span>
                            {activePoint.error === null
                                ? 'No matched data'
                                : activePoint.error > 0
                                    ? 'Over-forecast'
                                    : activePoint.error < 0
                                        ? 'Under-forecast'
                                        : 'Exact match'}
                        </span>
                    </div>

                    <div className="chart-tooltip-grid">
                        <div>
                            <span>Forecast</span>
                            <strong>{formatNumber(activePoint.forecast)}</strong>
                        </div>
                        <div>
                            <span>Actual</span>
                            <strong>{formatNumber(activePoint.actual)}</strong>
                        </div>
                        <div>
                            <span>Signed error</span>
                            <strong>{formatSignedError(activePoint.error)}</strong>
                        </div>
                        <div>
                            <span>Forecast published</span>
                            <strong>
                                {activePoint.publishTime
                                    ? formatUtcPublication(activePoint.publishTime)
                                    : 'No matched data'}
                            </strong>
                        </div>
                    </div>

                    {activePoint.error !== null && (
                        <p className="chart-tooltip-explanation">
                            {activePoint.error > 0
                                ? 'Forecast generation was higher than actual generation for this hour.'
                                : activePoint.error < 0
                                    ? 'Actual generation was higher than forecast generation for this hour.'
                                    : 'Forecast and actual generation were equal for this hour.'}
                        </p>
                    )}
                </div>
            )}

            <p className="chart-footnote">
                Positive error means generation was over-forecast. Negative error
                means actual generation exceeded the forecast. Missing hours are
                shown as gaps and are excluded from matched-hour accuracy metrics.
            </p>

            <details className="chart-data">
                <summary>View hourly data table</summary>
                <div className="table-scroll">
                    <table>
                        <thead>
                            <tr>
                                <th>Delivery hour (UTC)</th>
                                <th>Forecast (MW)</th>
                                <th>Actual (MW)</th>
                                <th>Error (MW)</th>
                                <th>Published (UTC)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {points.map(point => (
                                <tr key={point.time}>
                                    <td>{point.label}</td>
                                    <td>{formatNumber(point.forecast)}</td>
                                    <td>{formatNumber(point.actual)}</td>
                                    <td>{formatSignedError(point.error)}</td>
                                    <td>
                                        {point.publishTime
                                            ? formatUtcPublication(point.publishTime)
                                            : 'No matched data'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </details>
        </section>
    )
}
