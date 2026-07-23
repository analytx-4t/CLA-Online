import { useId } from 'react';

export default function LineChart({ points, accent = '#0C8742', showArea = true }) {
  const gradientId = useId();
  const width = 360;
  const height = 170;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = Math.max(max - min, 1);
  const denom = Math.max(points.length - 1, 1);
  const path = points
    .map((value, index) => {
      const x = (index / denom) * width;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showArea && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path d={path} fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((value, index) => {
        const x = (index / denom) * width;
        const y = height - ((value - min) / range) * height;
        return <circle key={index} cx={x} cy={y} r="3" fill={accent} />;
      })}
    </svg>
  );
}
