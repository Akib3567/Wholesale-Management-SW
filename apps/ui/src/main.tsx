import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { ThemeProvider } from './theme/ThemeContext';
import './index.css';

// HashRouter: works identically from the Vite dev server and from file://
// inside the packaged Electron shell (phase 10).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </ThemeProvider>
  </StrictMode>,
);
