import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { NavProvider, useNav, type Route } from './nav';
import { network, useWallet } from './wallet';
import { keys as storeKeys } from './chain/store';
import { Toast } from './ui';
import { SecondKey, SetLimit, Welcome } from './screens/Onboarding';
import { ActivityScreen, Approve, Home, Receive, Review, Send, Sent } from './screens/Wallet';
import { AgentApprove, AgentKeyShown, AgentPaste, AgentRequest, Agents, NewBudget, RevokeAgent } from './screens/Agents';
import { getSession, setSession } from './chain/store';
import { Freeze, Guardian, RecoveryAlert, Restore, Unfreeze } from './screens/Guard';
import { DappRequest, Requests, Security } from './screens/Trust';
import { DappConnect, DappSign, DappTx, routeFor } from './screens/Sites';
import type { DappRequest as SiteRequest } from './dapp/protocol';

function Screen() {
  const { route } = useNav();
  const { state } = useWallet();
  switch (route.name) {
    case 'welcome': return <Welcome />;
    case 'secondKey': return <SecondKey />;
    case 'setLimit': return <SetLimit />;
    case 'dappRequest': return <DappRequest request={route.request} />;
    case 'sent': return <Sent {...route} />;
    case 'restore': return <Restore />;
  }
  // Every other screen needs an account.
  if (!state) return <Welcome />;
  switch (route.name) {
    case 'home': return <Home state={state} />;
    case 'send': return <Send state={state} />;
    case 'review': return <Review state={state} to={route.to} amount={route.amount} token={route.token} />;
    case 'approve': return <Approve state={state} request={route.request} />;
    case 'receive': return <Receive state={state} />;
    case 'activity': return <ActivityScreen state={state} />;
    case 'agents': return <Agents state={state} />;
    case 'newBudget': return <NewBudget state={state} />;
    case 'security': return <Security state={state} />;
    case 'requests': return <Requests state={state} />;
    case 'agentRequest': return <AgentRequest state={state} request={route.request} />;
    case 'dappConnect': return <DappConnect request={route.request} />;
    case 'dappTx': return <DappTx request={route.request} />;
    case 'dappSign': return <DappSign request={route.request} />;
    case 'agentKey': return <AgentKeyShown {...route} />;
    case 'revokeAgent': return <RevokeAgent state={state} address={route.address} />;
    case 'agentPaste': return <AgentPaste />;
    case 'agentApprove': return <AgentApprove state={state} request={route.request} />;
    case 'freeze': return <Freeze />;
    case 'unfreeze': return <Unfreeze state={state} />;
    case 'guardian': return <Guardian state={state} />;
    case 'recovery': return <RecoveryAlert state={state} />;
  }
}

function Loading() {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center text-muted">
      <Loader2 size={20} className="animate-spin" aria-label="Loading" />
    </div>
  );
}

/** Where the popup opens: a site's waiting request, home, or the next onboarding step. */
function startRoute(hasAccount: boolean, draftKeyCount: number, siteRequests: SiteRequest[], restoring: boolean): Route {
  if (hasAccount && siteRequests.length) return routeFor(siteRequests[0]);
  if (hasAccount) return { name: 'home' };
  if (restoring) return { name: 'restore' };
  if (draftKeyCount >= 2) return { name: 'setLimit' };
  if (draftKeyCount === 1) return { name: 'secondKey' };
  return { name: 'welcome' };
}

/** Toolbar popup: fixed 360x600. */
export function PopupApp({ devStart }: { devStart?: Route }) {
  const w = useWallet();
  return (
    <div className="relative h-[600px] w-[360px] overflow-y-auto overflow-x-hidden">
      {w.loading ? (
        <Loading />
      ) : (
        <NavProvider initial={devStart ?? startRoute(!!w.state, w.draftKeys.length, w.dappRequests, !!w.restore)}>
          <Screen />
          <Toast />
        </NavProvider>
      )}
    </div>
  );
}

function PanelBody() {
  const nav = useNav();
  const w = useWallet();
  // A both-key send handed over from the popup after the panel was already open.
  const { takePendingSend } = w;
  const { reset } = nav;
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const key = storeKeys.pendingSend(network.chainId);
    // Only a new handoff counts; activity updates during a send must not reset the screen.
    const onChange = async (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!changes[key]?.newValue) return;
      const p = await takePendingSend();
      if (p) reset({ name: 'review', to: p.to, amount: p.amount, token: p.token });
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [takePendingSend, reset]);
  // The popup handed over a both-key action after the panel was already open.
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const key = storeKeys.panelRoute(network.chainId);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const r = changes[key]?.newValue as Route | null | undefined;
      if (area !== 'session' || !r) return;
      void setSession(key, null);
      reset(r);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [reset]);
  // A site asks while the panel shows the request list: open it straight away.
  const newest = w.dappRequests[w.dappRequests.length - 1];
  const onList = nav.route.name === 'requests';
  useEffect(() => {
    if (newest && onList && w.state) reset(routeFor(newest));
  }, [newest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {nav.canGoBack && (
        <button type="button" onClick={nav.back} className="flex h-11 items-center gap-1 self-start px-3 pt-2 text-[13px] text-muted hover:text-fg">
          <ChevronLeft size={18} />All requests
        </button>
      )}
      {/* min-h-0 + overflow: the screen area scrolls, so tab screens (h-full) keep their tab bar at the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto"><Screen /></div>
      <Toast />
    </>
  );
}

/** Side panel: fluid width, full window height; the screen area scrolls. */
export function PanelApp() {
  const w = useWallet();
  // undefined = still checking for a send handed over from the popup.
  const [handed, setHanded] = useState<Route | null | undefined>(undefined);
  const checked = useRef(false); // takePendingSend clears the handoff, so read it only once
  useEffect(() => {
    if (w.loading || checked.current) return;
    checked.current = true;
    const routeKey = storeKeys.panelRoute(network.chainId);
    Promise.all([w.takePendingSend(), getSession<Route | null>(routeKey)]).then(([p, r]) => {
      if (r) void setSession(routeKey, null); // read once
      setHanded(p ? { name: 'review', to: p.to, amount: p.amount, token: p.token } : r ?? null);
    });
  }, [w.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative mx-auto flex h-screen max-w-[480px] flex-col">
      {w.loading || handed === undefined ? <Loading /> : (
        <NavProvider
          initial={handed ?? (!w.state ? (w.restore ? { name: 'restore' } : { name: 'welcome' }) : w.dappRequests.length ? routeFor(w.dappRequests[0]) : { name: 'requests' })}
          homeRoute={{ name: 'requests' }}
        >
          <PanelBody />
        </NavProvider>
      )}
    </div>
  );
}
