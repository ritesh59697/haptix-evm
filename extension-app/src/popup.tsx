import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Route } from './nav';
import { WalletProvider } from './wallet';
import { PopupApp } from './App';
import './styles.css';
import { applyAppearance } from './theme';

applyAppearance();

// Dev server only: ?screen=home opens a screen directly, ?sample=1 uses sample data.
const params = import.meta.env.DEV ? new URLSearchParams(location.search) : new URLSearchParams();
const devScreen = params.get('screen');
const useSample = params.get('sample') === '1';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider useSample={useSample}>
      <PopupApp devStart={devScreen ? ({ name: devScreen } as Route) : undefined} />
    </WalletProvider>
  </StrictMode>,
);
