import { useMemo, useState } from 'react';
import type { InteractionBucket } from '../types/aimfox';

interface OutreachChartProps {
  buckets: InteractionBucket[];
  rangeLabel: string;
}

type SeriesKey = 'sent_connections' | 'accepted_connections' | 'sent_messages' | 'replies';

const SERIES_META: Record<
  SeriesKey,
  { label: string; color: string; strokeWidth: number }
> = {
  sent_connections: { label: 'Sent Connections', color: '#0f766e', strokeWidth: 2.2 },
  accepted_connections: { label: 'Accepted', color: '#16a34a', strokeWidth: 2 },
  sent_messages: { label: 'Messages Sent', color: '#334155', strokeWidth: 2 },
  replies: { label: 'Replies', color: '#d97706', strokeWidth: 2.2 },
};

function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function OutreachChart({ buckets, rangeLabel }: OutreachChartProps) {
  const [visibleSeries, setVisibleSeries] = useState<Record<SeriesKey, boolean>>({
    sent_connections: true,
    accepted_connections: true,
    sent_messages: true,
    replies: true,
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 820;
  const height = 280;
  const pad = { top: 20, right: 16, bottom: 32, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const activeKeys = (Object.keys(SERIES_META) as SeriesKey[]).filter(
    (k) => visibleSeries[k],
  );

  const maxVal = useMemo(() => {
    let max = 4;
    for (const b of buckets) {
      for (const key of activeKeys) {
        if ((b[key] || 0) > max) max = b[key];
      }
    }
    return Math.ceil(max * 1.15);
  }, [buckets, activeKeys]);

  const yTicks = useMemo(() => {
    const steps = 4;
    const arr: number[] = [];
    for (let i = 0; i <= steps; i++) {
      arr.push(Math.round((maxVal / steps) * i));
    }
    return arr;
  }, [maxVal]);

  const toggleSeries = (key: SeriesKey) => {
    setVisibleSeries((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!Object.values(next).some(Boolean)) return prev;
      return next;
    });
  };

  if (buckets.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Outreach & Reply Velocity</h2>
          <span className="text-xs font-mono text-slate-500">{rangeLabel}</span>
        </div>
        <div className="h-[240px] flex items-center justify-center text-sm text-slate-500">
          No interaction buckets recorded for this selection.
        </div>
      </div>
    );
  }

  const getX = (idx: number) => {
    if (buckets.length === 1) return pad.left + plotW / 2;
    return pad.left + (idx / (buckets.length - 1)) * plotW;
  };

  const getY = (val: number) => {
    return pad.top + plotH - (val / maxVal) * plotH;
  };

  const buildPath = (key: SeriesKey) => {
    return buckets
      .map((b, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(b[key] || 0).toFixed(1)}`)
      .join(' ');
  };

  const labelStep = Math.max(1, Math.floor(buckets.length / 7));
  const hoveredBucket = hoverIndex !== null ? buckets[hoverIndex] : null;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Outreach & Reply Velocity</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Daily LinkedIn actions bucketed from Aimfox telemetry ({rangeLabel})
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(SERIES_META) as SeriesKey[]).map((key) => {
            const meta = SERIES_META[key];
            const active = visibleSeries[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleSeries(key)}
                className={`inline-flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-slate-50 border-slate-300 text-slate-900'
                    : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                }`}
              >
                <span
                  className="w-2.5 h-0.5 rounded-full"
                  style={{ backgroundColor: active ? meta.color : '#cbd5e1' }}
                />
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto overflow-visible select-none"
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* Horizontal gridlines & Y ticks */}
          {yTicks.map((tick) => {
            const y = getY(tick);
            return (
              <g key={tick}>
                <line
                  x1={pad.left}
                  y1={y}
                  x2={width - pad.right}
                  y2={y}
                  stroke="#e2e8f0"
                  strokeDasharray="3 3"
                />
                <text
                  x={pad.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-400 text-[11px] font-mono tabular-nums"
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {/* X Axis labels */}
          {buckets.map((b, i) => {
            if (i % labelStep !== 0 && i !== buckets.length - 1) return null;
            return (
              <text
                key={b.timestamp}
                x={getX(i)}
                y={height - 8}
                textAnchor="middle"
                className="fill-slate-400 text-[11px] font-mono tabular-nums"
              >
                {formatDateShort(b.timestamp)}
              </text>
            );
          })}

          {/* Series paths */}
          {activeKeys.map((key) => (
            <path
              key={key}
              d={buildPath(key)}
              fill="none"
              stroke={SERIES_META[key].color}
              strokeWidth={SERIES_META[key].strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Hover guide & interactive columns */}
          {hoverIndex !== null && (
            <line
              x1={getX(hoverIndex)}
              y1={pad.top}
              x2={getX(hoverIndex)}
              y2={pad.top + plotH}
              stroke="#94a3b8"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          )}

          {hoverIndex !== null &&
            activeKeys.map((key) => {
              const val = buckets[hoverIndex][key] || 0;
              return (
                <circle
                  key={`dot-${key}`}
                  cx={getX(hoverIndex)}
                  cy={getY(val)}
                  r={4}
                  fill="#ffffff"
                  stroke={SERIES_META[key].color}
                  strokeWidth={2.2}
                />
              );
            })}

          {buckets.map((b, i) => {
            const colWidth = buckets.length > 1 ? plotW / (buckets.length - 1) : plotW;
            const xStart = Math.max(pad.left, getX(i) - colWidth / 2);
            const xEnd = Math.min(width - pad.right, getX(i) + colWidth / 2);
            return (
              <rect
                key={`hit-${b.timestamp}`}
                x={xStart}
                y={pad.top}
                width={Math.max(4, xEnd - xStart)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(i)}
              />
            );
          })}
        </svg>

        {hoveredBucket && hoverIndex !== null && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs">
            <span className="font-mono font-medium text-slate-900 tabular-nums">
              {new Date(hoveredBucket.timestamp).toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <div className="flex flex-wrap items-center gap-5 font-mono tabular-nums text-slate-700">
              <span>Views: {hoveredBucket.views}</span>
              <span className="text-teal-700">Connects: {hoveredBucket.sent_connections}</span>
              <span className="text-emerald-700">Accepted: {hoveredBucket.accepted_connections}</span>
              <span className="text-slate-900">Messages: {hoveredBucket.sent_messages}</span>
              <span className="text-amber-700 font-semibold">Replies: {hoveredBucket.replies}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
