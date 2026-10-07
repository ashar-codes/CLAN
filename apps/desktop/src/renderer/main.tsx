import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import '@clan/design/tokens.css';
import './styles.css';
createRoot(document.getElementById('root')!).render(<App />);
