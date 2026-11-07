import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@jbenet/feedback-react/styles.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VIEWPORT_BOOT } from '@jbenet/feedback-react';
import { App } from './App';

// The kit's viewport-height script. With server rendering it goes inline in <head>; in a plain SPA,
// running it before the first render does the same job.
const boot = document.createElement('script');
boot.textContent = VIEWPORT_BOOT;
document.head.appendChild(boot);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
