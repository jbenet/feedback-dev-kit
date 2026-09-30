'use client';

import { useEffect, useRef, useState } from 'react';
import type { Issue } from './types';
import { issueVelocity } from './velocity';

export function IssueVelocity({ issues, now }: { issues: Issue[]; now?: Date }) {
  const velocity = issueVelocity(issues, now);
  const { days } = velocity;
  const maxActivity = Math.max(1, ...days.flatMap((d) => [d.filed, d.closed]));
  const maxOpen = Math.max(1, ...days.map((d) => d.openMax));
  // The chart is drawn at the card's own width, so it fills the card at any size with text at its
  // real size (a fixed viewBox scaled up would enlarge the labels, or leave the card half empty).
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(620);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(Math.max(320, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const right = width - 17;
  const step = (right - 14 - 38) / Math.max(1, days.length - 1);
  const bar = Math.min(14, Math.max(6, Math.floor(step * 0.32)));
  const x = (index: number) => 38 + index * step;
  const y = (value: number) => 192 - value / maxOpen * 48;
  const line = (key: 'openMin' | 'openMax') => days.map((d, i) => `${x(i)},${y(d[key])}`).join(' ');
  const first = days[0]!;
  const last = days.at(-1)!;
  const range = (min: number, max: number) => min === max ? String(min) : `${min}–${max}`;

  return (
    <section className="card issue-velocity" aria-labelledby="issue-velocity-title">
      <div className="chead">
        <h2 id="issue-velocity-title">Issue velocity</h2>
        <span className="lbl">Last 30 days · UTC · today so far</span>
      </div>
      <div className="cbody">
        <div className="velocity-stats">
          <span><b>{velocity.filed}</b> filed · {(velocity.filed / 30).toFixed(1)}/day</span>
          <span><b>{velocity.closed}</b> dated closures · {(velocity.closed / 30).toFixed(1)}/day</span>
          <span><b>{velocity.open}</b> open now</span>
        </div>
        <div className="velocity-legend">
          <span>▮ Filed</span><span className="velocity-closed">▯ Closed</span>
          <span>— Open count · dashed line: upper bound where dates are missing</span>
        </div>
        <div ref={wrap}>
        <svg viewBox={`0 0 ${width} 222`} width={width} height={222} role="img" aria-labelledby="velocity-chart-title" className="velocity-chart">
          <title id="velocity-chart-title">Daily issues filed and closed, and reconstructed open count. Exact values in the daily list below.</title>
          <text x="0" y="12">{maxActivity}</text><text x="0" y="99">0</text>
          <line x1="28" y1="96" x2={right} y2="96" className="velocity-axis" />
          {days.map((d, i) => (
            <g key={d.date}>
              <rect x={x(i) - bar - 1} y={96 - d.filed / maxActivity * 80} width={bar} height={d.filed / maxActivity * 80} className="velocity-filed-bar" />
              <rect x={x(i) + 1} y={96 - d.closed / maxActivity * 80} width={bar} height={d.closed / maxActivity * 80} className="velocity-closed-bar" />
            </g>
          ))}
          <text x="28" y="125">Open count</text>
          <text x="0" y="148">{maxOpen}</text><text x="0" y="195">0</text>
          <line x1="28" y1="192" x2={right} y2="192" className="velocity-axis" />
          <polyline points={line('openMax')} className="velocity-open upper" />
          <polyline points={line('openMin')} className="velocity-open" />
          <text x="28" y="216">{first.date}</text><text x={right} y="216" textAnchor="end">{last.date}</text>
        </svg>
        </div>
        <p className="muted velocity-note">
          Based on current issue files and their latest recorded closure; earlier close/reopen cycles are not recorded.
          {' '}{velocity.undatedClosures} done {velocity.undatedClosures === 1 ? 'issue has' : 'issues have'} no valid closure date and cannot be assigned to a day.
          {velocity.undatedFiled > 0 && <> {velocity.undatedFiled} issues also have no valid filing date.</>}
          {' '}Historical open counts show a range when dates are missing; today’s open count is exact.
        </p>
        <details className="more">
          <summary>Daily list · filed, closed and open counts</summary>
          <table className="list">
            <caption className="muted">{first.date} to {last.date} · UTC</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Filed</th><th scope="col">Dated closures</th><th scope="col">Open count</th></tr></thead>
            <tbody>{days.map((day) => (
              <tr key={day.date}><th scope="row">{day.date}</th><td>{day.filed}</td><td>{day.closed}</td><td>{range(day.openMin, day.openMax)}</td></tr>
            ))}</tbody>
          </table>
        </details>
      </div>
    </section>
  );
}
