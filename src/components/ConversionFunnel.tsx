import type { CampaignMetrics } from '../types/aimfox';

interface ConversionFunnelProps {
  totals: CampaignMetrics;
}

export function ConversionFunnel({ totals }: ConversionFunnelProps) {
  const steps = [
    {
      label: 'Profile Views',
      value: totals.views,
      base: Math.max(totals.views, 1),
      color: 'bg-slate-700',
    },
    {
      label: 'Connections Sent',
      value: totals.sent_connections,
      base: Math.max(totals.views, totals.sent_connections, 1),
      color: 'bg-teal-700',
    },
    {
      label: 'Connections Accepted',
      value: totals.accepted_connections,
      base: Math.max(totals.sent_connections, 1),
      color: 'bg-emerald-600',
    },
    {
      label: 'Follow-up Messages',
      value: totals.sent_messages,
      base: Math.max(totals.sent_messages, totals.sent_connections, 1),
      color: 'bg-slate-900',
    },
    {
      label: 'Lead Replies',
      value: totals.replies,
      base: Math.max(totals.sent_messages, 1),
      color: 'bg-amber-600',
    },
  ];

  const maxStepVal = Math.max(...steps.map((s) => s.value), 1);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900">Outreach Funnel</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Stage-by-stage volume and conversion yield
        </p>
      </div>

      <div className="space-y-4">
        {steps.map((step, index) => {
          const barPct = Math.max(2, Math.round((step.value / maxStepVal) * 100));
          const stepRate =
            index === 0
              ? '100%'
              : `${((step.value / Math.max(step.base, 1)) * 100).toFixed(1)}%`;

          return (
            <div key={step.label}>
              <div className="flex items-baseline justify-between text-xs mb-1.5">
                <span className="font-medium text-slate-700">{step.label}</span>
                <div className="flex items-center gap-2 font-mono tabular-nums">
                  <span className="font-semibold text-slate-900">
                    {step.value.toLocaleString()}
                  </span>
                  {index > 0 && (
                    <span className="text-slate-400">· {stepRate}</span>
                  )}
                </div>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-sm overflow-hidden">
                <div
                  className={`h-full ${step.color} transition-all duration-300`}
                  style={{ width: `${barPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
