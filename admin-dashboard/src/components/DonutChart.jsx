export default function DonutChart({ segments }) {
  const total = segments.reduce((sum, item) => sum + item.value, 0) || 1;
  let startAngle = 0;

  const radius = 48;
  const center = 60;
  const strokeWidth = 14;

  const circumference = 2 * Math.PI * radius;

  return (
    <div className="flex items-center gap-3">
      <svg width="120" height="120" viewBox="0 0 120 120">
        {segments.map((segment, idx) => {
          const portion = segment.value / total;
          const dashArray = `${portion * circumference} ${circumference}`;
          const rotation = (startAngle / total) * 360;
          startAngle += segment.value;

          return (
            <circle
              key={segment.label}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset="0"
              transform={`rotate(${rotation} ${center} ${center})`}
              strokeLinecap="butt"
            />
          );
        })}
        <circle cx={center} cy={center} r={radius - strokeWidth / 2} style={{ fill: 'rgb(var(--surface-muted))' }} />
      </svg>
      <div className="flex flex-col gap-1 text-sm text-ink">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
            <span>{segment.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
