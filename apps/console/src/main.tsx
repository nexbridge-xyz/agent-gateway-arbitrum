import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/app.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';

import { TooltipProvider } from '@/components/ui/tooltip';
import { wagmiConfig } from '@/lib/wallet';

import { App } from './App';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root element');

createRoot(root).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
