# Planeador de Férias

Planeador de viagens com grelha de horas arrastável, servido por um único binário.
A imagem Docker tem cerca de 7 MB e não precisa de base de dados: cada viagem é um ficheiro JSON.

## O que está aqui

| Ficheiro | Para que serve |
| --- | --- |
| `*.go` | Servidor, só com a biblioteca padrão do Go: `main.go` (arranque), `routes.go` (API), `auth.go` (login e sessões), `trips.go` (ficheiros das viagens e cópias), `static.go` (página embutida). |
| `web/` | A página: `index.html`, `css/app.css` e `js/` em módulos ES sem build (`js/main.js` é a entrada, liga as partes e lista o que cada módulo faz; `js/` tem a lógica, sem DOM, e `js/ui/` a interface; `js/i18n.js` tem os textos em português e inglês e `js/tz.js` as contas dos fusos horários). Fica embutida no binário. |
| `Dockerfile` | Compila e produz a imagem final (`FROM scratch`). |
| `docker-compose.yml` | Arranque no servidor, com volume para os dados. |
| `*_test.go`, `tests/` | Testes do servidor (Go, um ficheiro de teste por ficheiro do servidor) e da página (Node, sem dependências). |
| `.github/workflows/ci.yml` | Em cada PR: formato, análise estática, testes, vulnerabilidades e arranque da imagem Docker. |
| `.github/workflows/docker.yml` | Publica a imagem em `ghcr.io` a cada push para `master`, depois de correr os testes. |

## Arrancar no servidor

1. Cria o ficheiro de configuração e escolhe o login:

   ```sh
   cp .env.example .env
   # edita .env: PLANNER_USER e PLANNER_PASSWORD (mínimo 10 caracteres)
   ```

2. No `docker-compose.yml`, troca o nome da rede `caddy` pelo da rede onde está o teu Caddy
   (`docker network ls`).

3. Arranca:

   ```sh
   docker compose up -d --build
   ```

4. Acrescenta ao Caddyfile e recarrega o Caddy:

   ```
   ferias.noodleserver.fyi {
           encode gzip zstd
           reverse_proxy planeador_ferias:8080 {
                   lb_try_duration 30s
           }
           tls {
                   dns cloudflare {env.CLOUDFLARE_DNS_TOKEN}
           }
   }
   ```

5. Abre o endereço, entra com o login do `.env` e usa **Importar** para carregar uma cópia
   de segurança (`.json`) com as viagens que já tens.

## Configuração

| Variável | Obrigatória | Valor por omissão | Descrição |
| --- | --- | --- | --- |
| `PLANNER_USER` | sim | — | Nome de utilizador do login. |
| `PLANNER_PASSWORD` | sim | — | Palavra-passe (mínimo 10 caracteres). |
| `PLANNER_HOME_TZ` | não | fuso do browser | Segundo fuso mostrado na grelha, ao lado da hora da viagem (ex.: `Europe/Lisbon`). Cada dispositivo pode escolher outro. |
| `DATA_DIR` | não | `/data` na imagem | Pasta dos dados. |
| `PORT` | não | `8080` | Porta onde o servidor ouve. |

Mudar a palavra-passe termina todas as sessões abertas.

## Publicar alterações

O código e os dados estão separados: o código vai na imagem, os dados ficam no volume.
Atualizar a imagem nunca toca nas viagens.

1. Cria um repositório no GitHub (pode ser privado) e faz push para `master`.
2. O workflow compila e publica `ghcr.io/<utilizador>/<repositório>:latest` (amd64 e arm64).
3. No `docker-compose.yml`, troca `OWNER/planeador-ferias` pelo caminho da tua imagem.
4. No servidor, a cada nova versão:

   ```sh
   docker compose pull && docker compose up -d
   ```

Um pacote novo no GHCR nasce privado. Ou o tornas público (a imagem não contém dados nem
palavras-passe), ou fazes `docker login ghcr.io` no servidor com um token com permissão
`read:packages`.

## Dados

```
/data
├── trips/<id>.json          uma viagem por ficheiro: {"rev", "updatedAt", "trip"}
├── backups/<id>/AAAA-MM-DD.json   versão anterior à primeira alteração de cada dia (últimas 30)
├── backups/<id>/apagada-….json    viagens apagadas (nunca são eliminadas do disco)
└── .session-secret          segredo que assina as sessões
```

- Dentro de cada viagem: `tz` (fuso da viagem, opcional: as horas da grelha são a hora local desse fuso), `blocks` (atividades, com `pp`/`total` e `ccat` para a categoria de custo), `costs`
  (custos do dia ou gerais), `costCats` (categorias) e `budget` (orçamento).
- As escritas são atómicas (ficheiro temporário + troca), por isso uma falha de energia não corrompe uma viagem.
- Cada viagem tem um número de revisão. Se dois dispositivos editarem a mesma viagem, o segundo a gravar
  recebe a versão mais recente em vez de a sobrepor.
- Para recuperar uma versão antiga, copia o ficheiro de `backups/` para `trips/<id>.json`
  e reinicia o contentor.
- Para ver os ficheiros: `docker run --rm -v planeador-ferias_planner_data:/data alpine ls -R /data`.
  Se preferires uma pasta normal em vez de um volume, usa `- ./data:/data` e
  `chown -R 65532:65532 ./data`.
- **Cópia de segurança** na página descarrega todas as viagens num só ficheiro; **Importar** junta-as de volta.

## Segurança

- Sessão por cookie assinado (`HttpOnly`, `SameSite=Strict`, `Secure` atrás de HTTPS), válida 30 dias
  e renovada sempre que a página é usada: só volta a pedir login depois de um mês sem abrir o planeador.
- Tentativas de login limitadas: 8 falhadas por endereço em 10 minutos.
- O contentor corre sem root, com sistema de ficheiros só de leitura e sem capabilities.
- A página carrega as fontes do Google Fonts. O módulo de Excel vem do cdnjs e só é pedido
  quando carregas em "Exportar Excel".

## Desenvolvimento

```sh
PLANNER_USER=eu PLANNER_PASSWORD=uma-palavra-passe go run .
# http://localhost:8080
```

Não há passo de build para a página: edita os ficheiros em `web/` e volta a correr.

### Testes

```sh
go test ./...                 # servidor: login, sessões, viagens, cópias, cabeçalhos
node --test tests/*.test.mjs  # página: sintaxe, traduções PT/EN completas e a lógica de web/js/
gofmt -l . && go vet ./...    # formato e análise

# cobertura (o CI exige os mínimos que estão em .github/workflows/ci.yml)
go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out | tail -1
node --test --experimental-test-coverage --test-coverage-include='web/js/*.js' --test-coverage-exclude='web/js/main.js' tests/*.test.mjs
```

O CI corre tudo isto em cada PR, mais `staticcheck`, `govulncheck`, `hadolint` e um arranque real
da imagem Docker com login, e falha se a cobertura descer abaixo dos mínimos. Ao acrescentar um
texto à página, põe-no em `web/js/i18n.js` nas duas línguas: o teste falha se faltar uma tradução.
