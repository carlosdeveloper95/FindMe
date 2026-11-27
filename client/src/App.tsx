import { useCallback, useEffect, useState } from 'react';
import { normalizeCode, type JoinResponse } from '@findme/shared';
import { Home } from './components/Home';
import { SessionView } from './components/SessionView';
import { clearSession, loadSession, saveSession, type StoredSession } from './storage';
import type { GoneReason } from './useSession';

interface Route {
  /** Código presente no endereço (/s/CODIGO), já normalizado. */
  code: string | null;
  /** O endereço tinha um código, mas mal formado. */
  invalid: boolean;
}

function parseRoute(): Route {
  const match = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!match) return { code: null, invalid: false };
  const code = normalizeCode(decodeURIComponent(match[1]!));
  return { code, invalid: code === null };
}

const GONE_NOTICE: Record<GoneReason, string | null> = {
  'ended-by-me': 'Sessão terminada. Os trajetos foram apagados do servidor.',
  'ended-by-friend': 'O teu amigo terminou a sessão. Os trajetos foram apagados do servidor.',
  expired: 'A sessão expirou ao fim de 24 horas e os trajetos foram apagados.',
  unauthorized: 'Essa sessão já não existe.',
};

export function App() {
  const [route, setRoute] = useState(parseRoute);
  const [stored, setStored] = useState<StoredSession | null>(loadSession);
  const [notice, setNotice] = useState<string | null>(() =>
    parseRoute().invalid ? 'Esse link de convite não é válido.' : null,
  );

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Um link para outra sessão tem prioridade sobre a que está guardada.
  const active = stored && (route.code === null || route.code === stored.code) ? stored : null;

  // Com sessão ativa, o endereço é sempre o link da sessão (recarregar mantém-na).
  useEffect(() => {
    if (!active) return;
    const path = `/s/${active.code}`;
    if (window.location.pathname !== path) {
      window.history.replaceState(null, '', path);
      setRoute(parseRoute());
    }
  }, [active]);

  const goHome = useCallback(() => {
    window.history.replaceState(null, '', '/');
    setRoute({ code: null, invalid: false });
  }, []);

  const onJoined = useCallback((res: JoinResponse) => {
    const session = { code: res.code, token: res.token, participantId: res.participant.id };
    saveSession(session);
    setNotice(null);
    setStored(session);
    window.history.pushState(null, '', `/s/${res.code}`);
    setRoute({ code: res.code, invalid: false });
  }, []);

  const onGone = useCallback(
    (reason: GoneReason) => {
      setStored((current) => {
        if (current) clearSession(current.code);
        return null;
      });
      setNotice(GONE_NOTICE[reason]);
      goHome();
    },
    [goHome],
  );

  if (active) return <SessionView key={active.code} creds={active} onGone={onGone} />;

  return (
    <Home
      inviteCode={route.code}
      notice={notice}
      onJoined={onJoined}
      onDismissInvite={() => {
        setNotice(null);
        goHome();
      }}
    />
  );
}
