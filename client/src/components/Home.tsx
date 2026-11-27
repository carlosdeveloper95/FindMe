import { useState, type FormEvent } from 'react';
import { NAME_MAX_LENGTH, formatCode, normalizeCode, type JoinResponse } from '@findme/shared';
import { createSession, errorMessage, joinSession } from '../api';
import { loadName, saveName } from '../storage';

interface Props {
  /** Código vindo de um link de convite (/s/CODIGO), se houver. */
  inviteCode: string | null;
  notice: string | null;
  onJoined: (res: JoinResponse) => void;
  onDismissInvite: () => void;
}

export function Home({ inviteCode, notice, onJoined, onDismissInvite }: Props) {
  const [name, setName] = useState(loadName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<JoinResponse>) => {
    if (busy) return;
    if (!name.trim()) {
      setError('Escreve o teu nome para continuar.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      saveName(res.participant.name);
      onJoined(res);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    void run(() => createSession(name));
  };

  const submitJoin = (e: FormEvent) => {
    e.preventDefault();
    const target = inviteCode ?? normalizeCode(code);
    if (!target) {
      setError('Esse código não é válido. Confirma os 10 caracteres.');
      return;
    }
    void run(() => joinSession(target, name));
  };

  const nameField = (
    <label className="field">
      <span>O teu nome</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={NAME_MAX_LENGTH}
        placeholder="Ex.: Ana"
        autoComplete="given-name"
        data-testid="name-input"
        required
      />
    </label>
  );

  return (
    <main className="home">
      <div className="home__card">
        <img className="home__logo" src="/icon.svg" alt="" width={72} height={72} />
        <h1>FindMe</h1>
        <p className="home__tagline">
          Partilha a localização com um amigo e vejam no mapa o caminho de cada um, em tempo real.
        </p>

        {notice && (
          <p className="notice" role="status" data-testid="home-notice">
            {notice}
          </p>
        )}
        {error && (
          <p className="notice notice--error" role="alert" data-testid="home-error">
            {error}
          </p>
        )}

        {inviteCode ? (
          <form onSubmit={submitJoin} className="form">
            <p className="home__invite">
              Foste convidado para a sessão <strong>{formatCode(inviteCode)}</strong>
            </p>
            {nameField}
            <button className="btn btn--primary" disabled={busy} data-testid="join-button">
              {busy ? 'A entrar…' : 'Entrar na sessão'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onDismissInvite}>
              Criar antes uma sessão nova
            </button>
          </form>
        ) : (
          <>
            <form onSubmit={submitCreate} className="form">
              {nameField}
              <button className="btn btn--primary" disabled={busy} data-testid="create-button">
                {busy ? 'A criar…' : 'Criar sessão'}
              </button>
            </form>

            <div className="divider">ou entra com um código</div>

            <form onSubmit={submitJoin} className="form">
              <label className="field">
                <span>Código de convite</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCDE-FGHJK"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={14}
                  className="field__code"
                  data-testid="code-input"
                />
              </label>
              <button className="btn btn--secondary" disabled={busy || !code.trim()} data-testid="join-button">
                Entrar
              </button>
            </form>
          </>
        )}

        <p className="home__privacy">
          A tua localização só é enviada depois de carregares em «Partilhar a minha localização».
          Podes pausar quando quiseres. Os trajetos são apagados ao terminar a sessão ou, no máximo,
          ao fim de 24 horas.
        </p>
      </div>
    </main>
  );
}
