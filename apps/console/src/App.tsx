import { useEffect, useRef } from 'react';

import { Shell } from '@/components/Shell';
import { useRoute } from '@/lib/route';
import { Approvals } from '@/screens/Approvals';
import { Evidence } from '@/screens/Evidence';
import { Feed } from '@/screens/Feed';
import { Ledger } from '@/screens/Ledger';
import { Mandates } from '@/screens/Mandates';

export function App() {
  const route = useRoute();

  // When the screen changes, the focus moves to its title. Someone using the keyboard or a screen
  // reader then continues in the new screen instead of staying on the link they pressed. The first
  // screen leaves the focus alone.
  const shown = useRef(`${route.screen}/${route.param ?? ''}`);
  useEffect(() => {
    const now = `${route.screen}/${route.param ?? ''}`;
    if (shown.current === now) return;
    shown.current = now;
    document.getElementById('screen-title')?.focus();
  }, [route.screen, route.param]);

  return (
    <Shell screen={route.screen}>
      {route.screen === 'feed' ? <Feed /> : null}
      {route.screen === 'approvals' ? <Approvals /> : null}
      {route.screen === 'mandates' ? <Mandates /> : null}
      {route.screen === 'evidence' ? <Evidence intentId={route.param} /> : null}
      {route.screen === 'ledger' ? <Ledger /> : null}
    </Shell>
  );
}
