import { useEffect, useMemo, useState } from 'react'
import {
  getLeadTimeHours,
  type HourlyObservation,
} from '../domain/analysis'

type SortKey =
  | 'startTime'
  | 'forecastGeneration'
  | 'actualGeneration'
  | 'error'
  | 'absoluteError'
  | 'publishTime'
  | 'leadTime'

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
  })

  return `${value > 0 ? '+' : ''}${formatted} MW`
}

function getErrorDirection(error: number | null): string {
  if (error === null) return 'No matched comparison'
  if (error > 0) return 'Over-forecast'
  if (error < 0) return 'Under-forecast'
  return 'Exact match'
}

export default function HourlyTable({
  observations,
  selectedHour,
  decisionCutoff,
  onSelectHour,
}: {
  observations: HourlyObservation[]
  selectedHour: string | null
  decisionCutoff: string
  onSelectHour: (hour: string) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('startTime')
  const [descending, setDescending] = useState(false)

  const matchedRows = useMemo(
    () => observations.filter(row => row.matched),
    [observations],
  )

  useEffect(() => {
    if (!selectedHour) {
      return
    }

    const row = document.querySelector(
      `tr[data-hour="${CSS.escape(selectedHour)}"]`,
    )

    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedHour])


  const sortedRows = useMemo(() => {
    return [...observations].sort((a, b) => {
      // Keep unmatched hours at the bottom for every sort order.
      if (sortKey !== 'startTime' && a.matched !== b.matched) {
        return a.matched ? -1 : 1
      }

      let comparison = 0

      switch (sortKey) {
        case 'forecastGeneration':
          comparison =
            a.forecastGeneration === null
              ? b.forecastGeneration === null ? 0 : 1
              : b.forecastGeneration === null
                ? -1
                : a.forecastGeneration - b.forecastGeneration
          break

        case 'actualGeneration':
          comparison =
            a.actualGeneration === null
              ? b.actualGeneration === null ? 0 : 1
              : b.actualGeneration === null
                ? -1
                : a.actualGeneration - b.actualGeneration
          break

        case 'error':
          comparison =
            a.error === null
              ? b.error === null ? 0 : 1
              : b.error === null
                ? -1
                : a.error - b.error
          break

        case 'absoluteError':
          comparison =
            a.absoluteError === null
              ? b.absoluteError === null ? 0 : 1
              : b.absoluteError === null
                ? -1
                : a.absoluteError - b.absoluteError
          break

        case 'publishTime': {
          const aTime = a.publishTime ? Date.parse(a.publishTime) : NaN
          const bTime = b.publishTime ? Date.parse(b.publishTime) : NaN

          comparison =
            Number.isNaN(aTime)
              ? Number.isNaN(bTime) ? 0 : 1
              : Number.isNaN(bTime)
                ? -1
                : aTime - bTime
          break
        }

        case 'leadTime':
          comparison =
            a.leadTimeHours === null
              ? b.leadTimeHours === null ? 0 : 1
              : b.leadTimeHours === null
                ? -1
                : a.leadTimeHours - b.leadTimeHours
          break

        default:
          comparison = Date.parse(a.startTime) - Date.parse(b.startTime)
      }

      // Reverse valid values for descending order, but keep missing
      // values at the bottom. Use delivery time to break ties consistently.
      if (sortKey !== 'startTime' && comparison !== 0) {
        const aMissing =
          (sortKey === 'forecastGeneration' && a.forecastGeneration === null) ||
          (sortKey === 'actualGeneration' && a.actualGeneration === null) ||
          (sortKey === 'error' && a.error === null) ||
          (sortKey === 'absoluteError' && a.absoluteError === null) ||
          (sortKey === 'publishTime' && !a.publishTime) ||
          (sortKey === 'leadTime' && a.leadTimeHours === null)

        const bMissing =
          (sortKey === 'forecastGeneration' && b.forecastGeneration === null) ||
          (sortKey === 'actualGeneration' && b.actualGeneration === null) ||
          (sortKey === 'error' && b.error === null) ||
          (sortKey === 'absoluteError' && b.absoluteError === null) ||
          (sortKey === 'publishTime' && !b.publishTime) ||
          (sortKey === 'leadTime' && b.leadTimeHours === null)

        if (aMissing !== bMissing) {
          return aMissing ? 1 : -1
        }

        return (descending ? -comparison : comparison) ||
          a.startTime.localeCompare(b.startTime)
      }

      return comparison || a.startTime.localeCompare(b.startTime)
    })
  }, [observations, sortKey, descending])


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
          aria-label={`Sort by ${label}${active ? `, ${descending ? 'descending' : 'ascending'}` : ''
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

    const values = sortedRows
      .filter(row => row.matched)
      .map(row => [
        row.startTime,
        row.forecastGeneration,
        row.actualGeneration,
        row.error,
        row.absoluteError,
        row.publishTime,
        row.publishTime
          ? getLeadTimeHours(row.startTime, row.publishTime).toFixed(2)
          : '',
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
    <section className="evidence-panel" aria-labelledby="hourly-comparison-heading">
      <div className="panel-heading">
        <p className="eyebrow">DELIVERY-HOUR EVIDENCE</p>
        <h2 id="hourly-comparison-heading">Hourly comparison</h2>
        <p>
          Each delivery hour uses the latest forecast published at or before
          the decision cutoff. A single publication can contain forecasts for
          many delivery hours, so publication timestamps may repeat. Later
          publications are excluded to avoid using information that was not
          available when the decision was made. Hours without a matched
          forecast-and-actual pair are shown as gaps; the response does not
          identify whether the forecast, the actual reading, or both are
          missing. All timestamps are UTC. Lead time is the interval between
          forecast publication and the start of the delivery hour.
        </p>
      </div>

      <div className="table-toolbar">
        <span>
          {matchedRows.length} matched of {observations.length} expected
          delivery hours
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={exportCsv}
          disabled={matchedRows.length === 0}
        >
          Export matched rows (CSV)
        </button>
      </div>

      {observations.length === 0 ? (
        <p className="empty-copy">
          No expected delivery hours are available for this window.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="table-caption">
              Forecast and actual-generation observations, including unmatched hours
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
                <tr
                  key={row.startTime}
                  data-hour={row.startTime}
                  className={
                    selectedHour === row.startTime ? 'is-selected' : undefined
                  }
                  onClick={() => onSelectHour(row.startTime)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectHour(row.startTime)
                    }
                  }}
                  tabIndex={0}
                  aria-selected={selectedHour === row.startTime}
                >
                  <td>{formatUtc(row.startTime)}</td>
                  <td>{formatMw(row.forecastGeneration)}</td>
                  <td>{formatMw(row.actualGeneration)}</td>
                  <td
                    className={
                      row.error === null
                        ? ''
                        : row.error > 0
                          ? 'error-positive'
                          : row.error < 0
                            ? 'error-negative'
                            : ''
                    }
                  >
                    {formatSignedMw(row.error)}
                    <span className="hourly-error-direction">
                      {getErrorDirection(row.error)}
                    </span>
                  </td>
                  <td>{formatMw(row.absoluteError)}</td>
                  <td>
                    {row.publishTime ? formatUtc(row.publishTime) : '—'}
                  </td>
                  <td>
                    {row.leadTimeHours === null
                      ? '—'
                      : `${row.leadTimeHours.toFixed(1)} h`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="footnote">
        The CSV contains matched comparisons only, in the current sort order.
        Missing observations are never filled with zero.
      </p>
    </section>
  )
}
