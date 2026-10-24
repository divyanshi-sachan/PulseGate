// Must stay first: configures Zod before any schema is constructed (see zod-config.ts).
import './zod-config.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import './design/tokens.css';
import './design/base.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
