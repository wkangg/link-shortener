import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

const el = document.querySelector('#root');
if (!el) throw new Error('#root not found');
createRoot(el).render(<App />);
