import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';
import flagFontUrl from 'country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

// Windows has no flag emoji glyphs; there this loads a flags-only font (listed in --sans).
polyfillCountryFlagEmojis('Twemoji Country Flags', flagFontUrl);

const el = document.querySelector('#root');
if (!el) throw new Error('#root not found');
createRoot(el).render(<App />);
