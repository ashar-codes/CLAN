// Personal study history (last 30 days): sessions, time, topics and card reviews per course. Only yours; never compared.
import { api } from '../../App.tsx';
import { useLoad } from '../useLoad.ts';
import { useStudy } from './common.tsx';

export function History() {
  const [rows] = useLoad(api.study.history);
  const { start } = useStudy();
  if (!rows) return null;
  return (
    <div className="stack">
      <p className="muted small-text">Last 30 days, on this device only. No streaks, no comparisons.</p>
      {rows.length ? (
        <table className="course-table"><thead><tr><th>Course</th><th>Sessions</th><th>Time</th><th>Topics studied</th><th>Card reviews</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.courseId ?? 'general'}><td>{r.course}</td><td className="c-num">{r.sessions}</td><td className="c-num">{Math.floor(r.minutes / 60) ? `${Math.floor(r.minutes / 60)} h ` : ''}{Math.round(r.minutes % 60)} min</td><td className="c-num">{r.topics}</td><td className="c-num">{r.reviews}</td></tr>)}</tbody></table>
      ) : <div className="empty-place"><b>No study sessions yet.</b><button className="primary" onClick={() => void start({ goal: 'Study', focus: true })}>Start one now</button></div>}
    </div>
  );
}
