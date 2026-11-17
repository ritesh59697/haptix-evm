import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WalletProvider } from './wallet';
import { PanelApp } from './App';
import './styles.css';
import { applyAppearance } from './theme';

applyAppearance();

// The side panel's request queue isn't wired yet; on the dev server ?sample=1 shows sample requests.
const useSample = import.meta.env.DEV && new URLSearchParams(location.search).get('sample') === '1';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider useSample={useSample}>
      <PanelApp />
    </WalletProvider>
  </StrictMode>,
);
