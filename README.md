# FindMe

Aplicação web (PWA) para dois amigos partilharem a localização em tempo real e
verem, no mesmo mapa, o caminho percorrido por cada um.

- A pessoa X cria uma sessão e envia o link ou o código de convite à pessoa Y.
- Cada um carrega em **Partilhar a minha localização** e passa a aparecer no mapa
  com um marcador e uma linha da sua cor (azul para quem cria, laranja para quem entra).
- Distância entre os dois, distância percorrida por cada um, hora da última
  atualização e estado (a partilhar / em pausa / offline).
- Pausar, retomar, centrar em mim, centrar no amigo, ver os dois, terminar sessão.

## Requisitos

- Node.js 20 ou superior
- npm 10 ou superior

## Instalação e desenvolvimento

```bash
npm install
```

```bash
npm run dev
```

Um único comando arranca o servidor (porta 3001) e o cliente (porta 5173).
Abre <http://localhost:5173>. Para experimentar sozinho, abre a app em dois
browsers (ou numa janela normal e noutra privada) e simula localizações
diferentes nas ferramentas de programador (Chrome: *More tools → Sensors*).

### Testar num telemóvel da mesma rede

Os browsers só dão acesso à geolocalização em HTTPS (ou em `localhost`).
Este comando serve o cliente com um certificado auto-assinado:

```bash
npm run dev:https
```

Abre no telemóvel `https://<IP-do-computador>:5173` e aceita o aviso do certificado.

## Testes

```bash
npm test
```

```bash
npm run typecheck
```

Os testes cobrem a filtragem de pontos e o cálculo de distâncias (`shared/`),
a gestão de sessões e a sincronização em tempo real (`server/`).

## Estrutura

```text
shared/   lógica comum: distâncias, filtragem de pontos, códigos, tipos
server/   Express + Socket.IO + SQLite (sessões, participantes, pontos)
client/   React + Vite + Leaflet, instalável como PWA
```

### Modelo de dados

| Tabela | Campos |
| --- | --- |
| `sessions` | `code`, `created_at`, `expires_at` |
| `participants` | `id`, `session_code`, `slot`, `name`, `color`, `token_hash`, `joined_at` |
| `points` | `id`, `participant_id`, `lat`, `lng`, `accuracy`, `ts` |

### Regras do trajeto

- Posições com precisão pior que 50 m são ignoradas.
- Um ponto só entra no trajeto se estiver a 8 m ou mais do último ponto guardado.
- Os limites estão em `shared/src/constants.ts`.

## Produção

```bash
npm run build
```

```bash
npm start
```

O servidor Node serve a API, o tempo real e o cliente já compilado, tudo na
mesma porta.

| Variável | Predefinição | Descrição |
| --- | --- | --- |
| `PORT` | `3001` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de escuta |
| `DB_PATH` | `server/data/findme.db` | Ficheiro SQLite (usa um volume persistente) |
| `TRUST_PROXY` | `0` | N.º de proxies à frente do servidor (põe `1` atrás de um reverse proxy) |

### HTTPS

A geolocalização exige HTTPS, por isso o servidor deve ficar atrás de um
reverse proxy com TLS que também encaminhe WebSockets. Exemplo com
[Caddy](https://caddyserver.com), que trata dos certificados sozinho:

```text
findme.exemplo.pt {
    reverse_proxy localhost:3001
}
```

Arranca o servidor com `TRUST_PROXY=1` para o limite de tentativas usar o IP
real de cada visitante. Em plataformas como Render, Fly.io ou Railway o HTTPS
já vem incluído: usa `npm install && npm run build` como comando de build,
`npm start` como comando de arranque e um disco persistente para `DB_PATH`.

## Privacidade e segurança

- Nada é enviado antes de o utilizador carregar em «Partilhar a minha
  localização» e dar permissão ao browser; há um indicador sempre visível
  enquanto a partilha está ativa.
- O código da sessão tem 10 caracteres aleatórios (50 bits) e há limite de
  tentativas por IP. Cada participante recebe um token secreto, guardado só
  no seu dispositivo (o servidor guarda apenas o hash). Sem token não se lê
  nem escreve nada, e a sessão fecha-se a terceiros quando entram os dois.
- Terminar a sessão apaga de imediato a sessão, os participantes e os pontos.
  As sessões não terminadas são apagadas ao fim de 24 horas.

## Limitações conhecidas

- É uma aplicação web: quando o ecrã bloqueia ou o browser vai para segundo
  plano, o sistema operativo suspende o envio da localização e a pessoa
  aparece como offline ao fim de 30 segundos. Para registar o caminho com o
  telemóvel no bolso é preciso uma app nativa com localização em segundo plano.
- Os mapas vêm dos servidores públicos do OpenStreetMap, adequados a uso
  pessoal; para muito tráfego, usa um fornecedor de tiles próprio.
