// DEMO FIXTURES — Visual Lab only. Invented people, courses and links; never imported by the product app.
import type { CLANmateSpec, BeaconState } from '@clan/design';
import type { CourseBuildingViewModel, NearbyPersonViewModel } from '@clan/world';

const m = (s: Partial<CLANmateSpec>): CLANmateSpec => ({
  skin: '#d9a07a', hair: 'crop', hairColor: '#2b1d16', top: 'hoodie', topColor: '#df5a3b', bottom: 'jeans', bottomColor: '#3b5a7a',
  shoes: 'sneakers', shoeColor: '#f5efe4', accessory: null, backpack: '#4f8a63', ...s,
});

export const ME = { id: 'me', name: 'You', spec: m({ skin: '#a86b48', hair: 'curls', top: 'sweater', topColor: '#3f83cf', backpack: '#e3a92f' }) };

export const PEOPLE: (NearbyPersonViewModel & { course: string; note: string })[] = [
  { id: 'p1', name: 'Hana', distance: 'here', beacon: 'available', course: 'CS-201', note: 'Same table', spec: m({ skin: '#f1c7a5', hair: 'bob', hairColor: '#1d1410', top: 'tee', topColor: '#4f8a63', bottom: 'skirt', bottomColor: '#2e2a26', accessory: 'glasses', backpack: null }) },
  { id: 'p2', name: 'Omar', distance: 'here', beacon: 'studying', course: 'MATH-210', note: 'Library, level 2', spec: m({ skin: '#7a4a30', hair: 'buzz', top: 'jacket', topColor: '#2e3b33', bottomColor: '#9a9488', accessory: 'headphones' }) },
  { id: 'p3', name: 'Lucía', distance: 'near', beacon: 'presenting', course: 'CS-201', note: 'Room 3.14', spec: m({ skin: '#e8b896', hair: 'long', hairColor: '#6b3a1f', top: 'sweater', topColor: '#e3a92f', bottom: 'trousers', bottomColor: '#3b2f2a', shoes: 'boots', shoeColor: '#4a2f22', backpack: '#df5a3b' }) },
  { id: 'p4', name: 'Kofi', distance: 'near', beacon: 'transfer', course: 'PHYS-110', note: 'Sending notes', spec: m({ skin: '#5a3624', hair: 'curls', hairColor: '#120c09', top: 'hoodie', topColor: '#1f9a92', bottom: 'shorts', bottomColor: '#2e2a26' }) },
  { id: 'p5', name: 'Mei', distance: 'near', beacon: 'focus', course: 'MATH-210', note: 'Focus until 16:00', spec: m({ skin: '#f1c7a5', hair: 'bun', hairColor: '#1d1410', top: 'tee', topColor: '#f6d3c6', bottomColor: '#3b5a7a', accessory: 'scarf', backpack: '#3f83cf' }) },
  { id: 'p6', name: 'Arjun', distance: 'far', beacon: 'away', course: 'CS-201', note: 'Back at 14:30', spec: m({ skin: '#a86b48', hair: 'crop', hairColor: '#1d1410', top: 'jacket', topColor: '#df5a3b', bottom: 'trousers', bottomColor: '#2e3b33', accessory: 'cap', backpack: '#2e2a26' }) },
  { id: 'p7', name: 'Sara', distance: 'far', beacon: 'studying', course: 'PHYS-110', note: 'Lab building', spec: m({ skin: '#d9a07a', hair: 'long', hairColor: '#2b1d16', top: 'hoodie', topColor: '#9a9488', bottom: 'jeans', accessory: 'glasses', backpack: '#4f8a63' }) },
];

export const COURSES: CourseBuildingViewModel[] = [
  { id: 'c1', code: 'CS-101', name: 'Intro to Programming', color: '#4f8a63', term: 1, studyingNow: 1, resources: 3, prerequisites: [], lectures: Array.from({ length: 8 }, (_, i) => ({ id: `c1l${i}`, title: `Lecture ${i + 1}`, done: true })) },
  { id: 'c2', code: 'MATH-110', name: 'Discrete Maths', color: '#3f83cf', term: 1, studyingNow: 0, resources: 2, prerequisites: [], lectures: Array.from({ length: 7 }, (_, i) => ({ id: `c2l${i}`, title: `Lecture ${i + 1}`, done: true })) },
  { id: 'c3', code: 'CS-201', name: 'Data Structures', color: '#df5a3b', term: 2, studyingNow: 4, resources: 4, prerequisites: ['c1', 'c2'], lectures: ['Arrays & lists', 'Stacks & queues', 'Hashing', 'Trees', 'Heaps', 'Graphs', 'Shortest paths', 'Review', 'Tries'].map((t, i) => ({ id: `c3l${i}`, title: t, done: i < 6 })) },
  { id: 'c4', code: 'MATH-210', name: 'Linear Algebra', color: '#e3a92f', term: 2, studyingNow: 2, resources: 2, prerequisites: ['c2'], lectures: Array.from({ length: 6 }, (_, i) => ({ id: `c4l${i}`, title: `Lecture ${i + 1}`, done: i < 4 })) },
  { id: 'c5', code: 'CS-310', name: 'Machine Learning', color: '#1f9a92', term: 3, studyingNow: 0, resources: 1, prerequisites: ['c3', 'c4'], lectures: Array.from({ length: 5 }, (_, i) => ({ id: `c5l${i}`, title: `Lecture ${i + 1}`, done: false })) },
  { id: 'c6', code: 'PHYS-110', name: 'Physics I', color: '#9a6b4f', term: 1, studyingNow: 1, resources: 2, prerequisites: [], lectures: Array.from({ length: 6 }, (_, i) => ({ id: `c6l${i}`, title: `Lecture ${i + 1}`, done: i < 5 })) },
];

export type SavedItem = { id: string; col: string; title: string; source: string; url: string; preview?: string; note?: string; tags: string[] };
export const COLLECTIONS = ['Inbox', 'Watch Later', 'Programming', 'AI', 'CS-201', 'Thesis ideas'];
export const SAVED: SavedItem[] = [
  { id: 's1', col: 'Inbox', title: 'Visualising Dijkstra step by step', source: 'youtube.com', url: 'https://example.com/dijkstra', preview: 'linear-gradient(135deg,#f6d3c6,#df5a3b)', tags: ['graphs'] },
  { id: 's2', col: 'Inbox', title: 'Lecture 6 board photo', source: 'Scan', url: '#', note: 'Bottom-left proof is the one on the exam', tags: ['CS-201'] },
  { id: 's3', col: 'Watch Later', title: 'How CPUs actually execute code', source: 'youtube.com', url: 'https://example.com/cpu', preview: 'linear-gradient(135deg,#d3e3f4,#3f83cf)', tags: ['systems'] },
  { id: 's4', col: 'Programming', title: 'Rust ownership in 10 diagrams', source: 'blog', url: 'https://example.com/rust', preview: 'linear-gradient(135deg,#f6e4b8,#e3a92f)', note: 'Good for the borrow-checker talk', tags: ['rust'] },
  { id: 's5', col: 'AI', title: 'Attention, explained without equations', source: 'arxiv.org', url: 'https://example.com/attention', preview: 'linear-gradient(135deg,#d5e6d6,#1f9a92)', tags: ['ml', 'reading'] },
  { id: 's6', col: 'CS-201', title: 'Past paper 2025 — Q3 hashing', source: 'CLAN · CS-201', url: '#', tags: ['exam'] },
  { id: 's7', col: 'Thesis ideas', title: 'Offline-first sync for classrooms', source: 'note', url: '#', note: 'Ask Dr. Rahman about scope', tags: ['idea'] },
  { id: 's8', col: 'Programming', title: 'Instagram reel: VS Code tips', source: 'instagram.com', url: 'https://example.com/reel', preview: 'linear-gradient(135deg,#ece3d3,#9a9488)', tags: ['tools'] },
];

export const FILES = [
  { id: 'f1', title: 'Graphs — lecture 6.pdf', kind: 'pdf', bytes: 2_400_000 },
  { id: 'f2', title: 'Problem set 4.pdf', kind: 'pdf', bytes: 380_000 },
  { id: 'f3', title: 'dijkstra.py', kind: 'code', bytes: 4_100 },
  { id: 'f4', title: 'Study plan.slides', kind: 'slides', bytes: 1_200_000 },
];

export const EXAMS = [
  { id: 'e1', course: 'CS-201 Data Structures', daysLeft: 6, readiness: 0.62, when: 'Mon 12 Oct · 09:00 · Hall B' },
  { id: 'e2', course: 'MATH-210 Linear Algebra', daysLeft: 9, readiness: 0.41, when: 'Thu 15 Oct · 13:00 · Room 2.04' },
  { id: 'e3', course: 'PHYS-110 Physics I', daysLeft: 14, readiness: 0.28, when: 'Tue 20 Oct · 10:00 · Lab 1' },
];
export const TOPICS = [
  { t: 'Hashing & collisions', conf: 0.8 }, { t: 'Balanced trees (AVL)', conf: 0.45 }, { t: 'Heaps & priority queues', conf: 0.7 },
  { t: 'Graph traversal', conf: 0.65 }, { t: 'Shortest paths', conf: 0.3 }, { t: 'Amortised analysis', conf: 0.2 },
];

export const MY_BEACON: BeaconState = 'available';
