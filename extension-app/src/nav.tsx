import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Request } from './data/sample';
import type { DappRequest } from './dapp/protocol';
import type { AgentRequest } from './chain/agents';
import { NotWiredError } from './wallet';

type SendBothKeys = Extract<Request, { kind: 'send-both-keys' }>;
type AgentOverBudget = Extract<Request, { kind: 'agent-over-budget' }>;
type DappApproval = Extract<Request, { kind: 'dapp-approval' }>;

export type Route =
  | { name: 'welcome' }
  | { name: 'secondKey' }
  | { name: 'setLimit' }
  | { name: 'home' }
  | { name: 'send' }
  | { name: 'review'; to: string; amount: string; token: string }
  | { name: 'sent'; to: string; amount: string; token: string; txHash: string; success: boolean; both: boolean }
  | { name: 'approve'; request: SendBothKeys }
  | { name: 'receive' }
  | { name: 'activity' }
  | { name: 'agents' }
  | { name: 'newBudget' }
  | { name: 'security' }
  | { name: 'requests' }
  | { name: 'agentRequest'; request: AgentOverBudget }
  | { name: 'dappRequest'; request: DappApproval }
  | { name: 'dappConnect'; request: Extract<DappRequest, { kind: 'dapp-connect' }> }
  | { name: 'dappTx'; request: Extract<DappRequest, { kind: 'dapp-tx' }> }
  | { name: 'dappSign'; request: Extract<DappRequest, { kind: 'dapp-sign' }> }
  | { name: 'agentKey'; agentName: string; privateKey: string; address: string; txHash: string }
  | { name: 'revokeAgent'; address: string }
  | { name: 'agentPaste' }
  | { name: 'agentApprove'; request: AgentRequest }
  | { name: 'freeze' }
  | { name: 'unfreeze' }
  | { name: 'guardian' }
  | { name: 'recovery' }
  | { name: 'restore' };

interface Nav {
  route: Route;
  canGoBack: boolean;
  go: (r: Route) => void;
  back: () => void;
  /** Replace the whole stack, for tab switches. */
  reset: (r: Route) => void;
  /** Where "Done" goes: home in the popup, the request list in the side panel. */
  homeRoute: Route;
  toast: string | null;
  /** Run a wallet action and show what happened. */
  run: (action: () => Promise<unknown>, done?: string, onSuccess?: () => void) => Promise<void>;
}

const NavContext = createContext<Nav | null>(null);

export function NavProvider({ initial, homeRoute = { name: 'home' }, children }: { initial: Route; homeRoute?: Route; children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const [toast, setToast] = useState<string | null>(null);

  const show = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string, onSuccess?: () => void) => {
      try {
        await action();
        if (done) show(done);
        onSuccess?.();
      } catch (e) {
        show(e instanceof NotWiredError ? e.message : `Something went wrong: ${(e as Error).message}`);
      }
    },
    [show],
  );

  const nav: Nav = {
    route: stack[stack.length - 1],
    canGoBack: stack.length > 1,
    go: (r) => setStack((s) => [...s, r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: (r) => setStack([r]),
    homeRoute,
    toast,
    run,
  };
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function useNav() {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('useNav outside NavProvider');
  return nav;
}
