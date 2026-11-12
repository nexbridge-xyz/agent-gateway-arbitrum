import { Shell } from '@/components/Shell';
import { useRoute } from '@/lib/route';
import { Approvals } from '@/screens/Approvals';
import { Evidence } from '@/screens/Evidence';
import { Feed } from '@/screens/Feed';
import { Ledger } from '@/screens/Ledger';
import { Mandates } from '@/screens/Mandates';

export function App() {
  const route = useRoute();
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
