// My Space: the room is the menu. Every object opens something real in the lab and shows a live count.
import type { KeyboardEvent, ReactNode } from 'react';
import { CLANBeacon, CLANmate, ExamIndicator } from '@clan/design';
import { COURSES, EXAMS, ME, PEOPLE } from '../demo/fixtures.ts';
import type { Lab, Route } from '../main.tsx';

function Obj({ label, hint, to, lab, children }: { label: string; hint: string; to: Route | (() => void); lab: Lab; children: ReactNode }) {
  const go = () => (typeof to === 'function' ? to() : lab.go(to));
  return (
    <g className="obj" role="link" tabIndex={0} aria-label={`${label}: ${hint}`} onClick={go} onKeyDown={(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && go()}>
      {children}
      <title>{label} — {hint}</title>
    </g>
  );
}

export function Home({ lab }: { lab: Lab }) {
  const inbox = lab.saved.filter((s) => s.col === 'Inbox').length;
  const next = EXAMS[0]!;
  let bx = 78;
  return (
    <div className="home">
      <svg className="room" viewBox="0 0 1000 560" role="group" aria-label="My Space">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#bcd8ef" /><stop offset="1" stopColor="#f6e4b8" /></linearGradient>
          <radialGradient id="lamp" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#ffe6a3" stopOpacity=".9" /><stop offset="1" stopColor="#ffe6a3" stopOpacity="0" /></radialGradient>
        </defs>
        <rect width="1000" height="400" fill="var(--paper)" />
        <path d="M0 400h1000v160H0z" fill="var(--paper-2)" />
        <path d="M0 400h1000" stroke="var(--line)" strokeWidth="6" />
        <g className="window"><rect x="560" y="60" width="200" height="150" rx="10" fill="url(#sky)" stroke="var(--line)" strokeWidth="8" /><path d="M660 60v150M560 135h200" stroke="var(--line)" strokeWidth="6" /></g>

        <Obj label="Bookshelf" hint="your courses on the Knowledge Campus" to="campus" lab={lab}>
          <rect x="60" y="120" width="200" height="290" rx="8" fill="#b88655" />
          <rect x="70" y="130" width="180" height="270" fill="#8f6440" />
          {[220, 310, 400].map((y) => <rect key={y} x="66" y={y - 6} width="188" height="10" fill="#c99a6b" />)}
          {COURSES.map((c, i) => {
            const shelf = i < 3 ? 214 : 304, h = 34 + 46 * (c.lectures.filter((l) => l.done).length / c.lectures.length);
            if (i === 3) bx = 78;
            const x = bx; bx += 26 + (i % 2) * 6;
            return <rect key={c.id} x={x} y={shelf - h} width={22 + (i % 2) * 6} height={h} rx="3" fill={c.color}><title>{c.code} · {Math.round((h - 34) / 46 * 100)}% of lectures</title></rect>;
          })}
          <text x="160" y="384" className="obj-label">Courses</text>
        </Obj>

        <Obj label="Calendar board" hint={`next exam ${next.course} in ${next.daysLeft} days`} to="exam" lab={lab}>
          <rect x="300" y="70" width="200" height="170" rx="10" fill="#d8b98f" stroke="#b88655" strokeWidth="6" />
          {EXAMS.map((e, i) => (
            <g key={e.id} transform={`translate(${318 + i * 60} ${92 + (i % 2) * 14}) rotate(${i === 1 ? 4 : -3})`}>
              <rect width="50" height="58" rx="3" fill={i === 0 ? 'var(--clay-soft)' : 'var(--surface)'} />
              <text x="25" y="28" textAnchor="middle" className="pin-num">{e.daysLeft}</text>
              <text x="25" y="44" textAnchor="middle" className="pin-sub">days</text>
              <circle cx="25" cy="4" r="4" fill="var(--clay)" />
            </g>
          ))}
          <text x="400" y="222" className="obj-label">Exams</text>
        </Obj>

        <g aria-hidden><rect x="420" y="330" width="380" height="20" rx="6" fill="#b88655" /><rect x="440" y="350" width="14" height="140" fill="#8f6440" /><rect x="766" y="350" width="14" height="140" fill="#8f6440" /></g>

        <Obj label="Laptop" hint="continue CS-201 · Graphs, slide 14" to="study" lab={lab}>
          <path d="M470 330l14-70h150l14 70z" fill="#2e3b33" /><path d="M490 270h138l-10 52H480z" fill="#9fc4e6" />
          <path d="M500 284h70M500 296h96M500 308h50" stroke="#2e3b33" strokeWidth="5" strokeLinecap="round" opacity=".5" />
          <text x="560" y="250" className="obj-label">Continue</text>
        </Obj>

        <Obj label="Journal" hint="your private Diary" to="diary" lab={lab}>
          <rect x="672" y="304" width="84" height="22" rx="4" fill="#4f8a63" transform="rotate(-6 714 315)" />
          <rect x="676" y="300" width="80" height="8" rx="2" fill="#f5efe4" transform="rotate(-6 714 315)" />
          <path d="M740 300v30" stroke="var(--clay)" strokeWidth="4" transform="rotate(-6 714 315)" />
          <text x="714" y="290" className="obj-label">Diary 🔒</text>
        </Obj>

        <Obj label="CLAN Guide" hint="contextual suggestions" to={() => dispatchEvent(new Event('clan:guide'))} lab={lab}>
          <circle cx="440" cy="240" r="70" fill="url(#lamp)" />
          <path d="M440 330v-60l-24-30" stroke="#2e3b33" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M396 230l36-22 16 26z" fill="#2e3b33" />
          <g className="guide-dots"><circle cx="432" cy="258" r="5" fill="var(--clay)" /><circle cx="446" cy="252" r="4" fill="var(--mustard)" /><circle cx="440" cy="268" r="3.5" fill="var(--sky)" /></g>
          <text x="440" y="190" className="obj-label">Guide</text>
        </Obj>

        <Obj label="Backpack" hint={`${inbox} things in your Inbox`} to="saved" lab={lab}>
          <path d="M800 520c-6-62 10-96 50-96s56 34 50 96z" fill="#e3a92f" /><rect x="822" y="460" width="56" height="34" rx="10" fill="#c98f1f" />
          <path d="M830 432c0-26 40-26 40 0" stroke="#c98f1f" strokeWidth="8" fill="none" />
          <circle cx="896" cy="436" r="17" fill="var(--clay)" /><text x="896" y="442" textAnchor="middle" className="badge">{inbox}</text>
          <text x="850" y="545" className="obj-label">Saved</text>
        </Obj>

        <Obj label="Commons" hint={`${PEOPLE.length} people nearby`} to="commons" lab={lab}>
          <rect x="880" y="120" width="110" height="282" rx="6" fill="#4f8a63" /><rect x="892" y="132" width="86" height="270" fill="#5e9a72" />
          <circle cx="968" cy="270" r="6" fill="#e3a92f" />
          <rect x="890" y="80" width="94" height="30" rx="15" fill="var(--surface)" /><text x="937" y="100" textAnchor="middle" className="door-sign">{PEOPLE.length} nearby</text>
          <text x="935" y="380" className="obj-label light">Commons →</text>
        </Obj>

        <g transform="translate(250 330)" aria-hidden><foreignObject width="130" height="168"><CLANmate spec={ME.spec} beacon={lab.beacon} size={160} /></foreignObject></g>
      </svg>

      <section className="today" aria-label="Today">
        <div className="c-card"><span className="c-eyebrow">Continue</span><b>CS-201 · Graphs</b><span className="muted">slide 14 of 32</span><button className="c-btn" onClick={() => lab.go('study')}>Open study room</button></div>
        <div className="c-card"><span className="c-eyebrow">Next exam</span><ExamIndicator course={next.course} daysLeft={next.daysLeft} readiness={next.readiness} /></div>
        <div className="c-card"><span className="c-eyebrow">Nearby</span>
          <div className="row tight">{PEOPLE.slice(0, 5).map((p) => <span key={p.id} className="mini-mate" title={p.name}><CLANmate spec={p.spec} size={46} /><CLANBeacon state={p.beacon} size={14} /></span>)}</div>
          <button className="c-btn" onClick={() => lab.go('commons')}>Go to Commons</button></div>
        <div className="c-card"><span className="c-eyebrow">Saved for later</span><b>{inbox} in Inbox</b><span className="muted">{lab.saved.length} saved overall</span><button className="c-btn" onClick={() => lab.go('saved')}>Sort them</button></div>
      </section>
    </div>
  );
}
