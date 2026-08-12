# Resumo diário da carteira por email

Envia-te um email automaticamente, todos os dias úteis, perto das 16:00 (hora
de Nova Iorque / fecho do mercado americano), com a variação total do dia em
valor e percentagem, mais um pequeno gráfico. Corre via GitHub Actions — não
precisas de ter nenhum browser ou computador aberto.

## Passo a passo (uns 10-15 minutos, uma única vez)

### 1. Criar conta na Resend (envio de emails, grátis)
1. Vai a **resend.com** e cria uma conta grátis (100 emails/dia, 3000/mês).
2. No painel, vai a **API Keys** → **Create API Key** → copia a chave (começa
   por `re_...`). Vais precisar dela no passo 4.
3. Por defeito, sem verificares um domínio próprio, só podes enviar a partir
   de `onboarding@resend.dev` — o suficiente para este caso de uso. Se um dia
   quiseres remetente com o teu próprio domínio, a Resend tem instruções para
   verificar um domínio (DNS).

### 2. Criar um repositório no GitHub
1. Vai a **github.com** e cria uma conta, se ainda não tiveres.
2. Cria um repositório novo — tem de ser **público** para poderes usar o
   GitHub Pages grátis (usado mais abaixo para o card do Apple Watch). Só
   fica exposto o `docs/summary.json` (valor total e variação do dia, sem
   nomes de ações nem detalhes de contas); os teus Secrets nunca ficam
   visíveis, mesmo num repositório público.
3. Faz upload destes 3 ficheiros para o repositório, **mantendo a mesma
   estrutura de pastas**:
   - `daily-summary.mjs`
   - `.github/workflows/daily-summary.yml`
   - `README.md` (este ficheiro, opcional)

   Mais fácil: no GitHub, usa "Add file" → "Upload files" e arrasta a pasta
   inteira (o GitHub mantém a estrutura de pastas automaticamente).

### 3. Configurar os "Secrets" (as tuas chaves privadas)
No repositório: **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Cria estes 5 secrets, um de cada vez:

| Nome | Valor |
|---|---|
| `SHEET_ID` | O ID da tua Google Sheet (a parte da URL entre `/d/` e `/edit`) |
| `SHEET_GID` | O GID da aba "Dashboard" (o número depois de `gid=` na URL dessa aba) |
| `RESEND_API_KEY` | A chave que copiaste no passo 1 |
| `EMAIL_TO` | O teu email, para onde queres receber o resumo |
| `EMAIL_FROM` | `onboarding@resend.dev` (ou o teu remetente verificado, se tiveres um) |

### 4. Testar
1. No repositório, vai a **Actions** → escolhe o workflow **"Resumo diário da
   carteira"** → botão **"Run workflow"** → confirma.
2. Isto testa a ligação e o envio, mas só envia mesmo o email se a hora atual
   corresponder às 16:00 em Nova Iorque — repara na mensagem nos "logs" da
   execução (clica na execução → no passo "Enviar resumo do dia") para veres
   se correu tudo bem ou o motivo de não ter enviado.
3. Já depois disso, corre sozinho todos os dias úteis, sem precisares de
   fazer mais nada.

## Perguntas frequentes

**E se eu quiser mudar a hora de envio?**
Edita as linhas `cron:` no ficheiro `.github/workflows/daily-summary.yml`.
O formato é `minuto hora dia mês dia-da-semana`, sempre em UTC.

**E se eu quiser incluir mais informação no email (ex.: ganhos/perdas
realizados)?**
Diz ao Claude o que queres acrescentar — o script (`daily-summary.mjs`) é
fácil de estender, já que segue a mesma lógica do dashboard.

**Os meus dados ficam seguros?**
Os Secrets do GitHub nunca ficam visíveis em texto (nem para ti depois de
criados, nem em logs), mesmo num repositório público. O único ficheiro
público é o `docs/summary.json` (valor total e variação do dia) — sem
nomes de ações, tickers ou detalhes de contas. A Google Sheet continua a
precisar de estar com partilha "Qualquer pessoa com o link — Leitor" para
o script conseguir ler os dados, tal como já tens configurado para o
dashboard.

## Extra: notícias semanais das maiores posições (no tab Research da app)

Todas as segundas-feiras (quando o script correr), identifica as tuas 5
maiores posições (por valor atual) e vai buscar 2 manchetes recentes de
cada uma ao Google News — grátis, sem chave de API nenhuma. Estas manchetes
ficam guardadas em `docs/news.json` (o mesmo mecanismo já usado para o
`docs/summary.json` do Apple Watch — precisas de ter o **GitHub Pages
ativo**, ver a secção seguinte).

O **dashboard HTML** (não este email) é que vai buscar esse ficheiro e
mostra as notícias no tab "Research". Isto só é possível porque o script
corre num servidor (GitHub Actions) — a maioria das fontes de notícias
bloqueia pedidos feitos diretamente do browser; ao gravar num ficheiro
estático, o browser só precisa de ler esse ficheiro, o que já funciona.

Nos dias que não são segunda-feira, o ficheiro simplesmente não é tocado —
a app continua a mostrar as notícias da última segunda-feira até à
próxima atualização.

Se quiseres mudar o dia da semana ou o número de posições/notícias, edita
as constantes `NEWS_TICKER_COUNT` e `NEWS_PER_TICKER`, e a função
`isMonday()`, no topo do `daily-summary.mjs`.

**No dashboard:** cola o URL do `docs/news.json` (o mesmo domínio do
`summary.json` que já configuraste) no campo de definições "URL das
notícias (Research)".

## Extra: card no Apple Watch (via Atalho / Shortcuts)

O script também escreve um pequeno ficheiro público `docs/summary.json` com
só o essencial (valor da carteira, variação do dia em € e %) — sem nomes de
ações nem detalhes de contas. Isto é lido por um Atalho no teu iPhone/Watch.

### 1. Ativar o GitHub Pages (repositório tem de ser público)
1. No repositório: **Settings** → **Pages**.
2. Em "Build and deployment" → "Source", escolhe **Deploy from a branch**.
3. Em "Branch", escolhe **main** e a pasta **/docs** → **Save**.
4. Passados 1-2 minutos, o teu resumo fica acessível em:
   `https://O-TEU-USERNAME.github.io/O-TEU-REPOSITORIO/summary.json`
   (troca `O-TEU-USERNAME` e `O-TEU-REPOSITORIO` pelos teus valores reais).
5. Só fica lá depois da primeira execução bem-sucedida do workflow (corre-o
   manualmente uma vez, como já indicado acima, para gerar o ficheiro).

### 2. Criar o Atalho (no iPhone, app "Atalhos" / "Shortcuts")
1. Abre a app **Atalhos** → separador **Meus Atalhos** → **+** (criar novo).
2. Dá-lhe o nome **"Carteira"**.
3. Adiciona a ação **"Obter Conteúdo de URL"** ("Get Contents of URL") → cola
   o URL do passo anterior (`https://.../summary.json`).
4. Adiciona a ação **"Obter Valor do Dicionário"** ("Get Dictionary Value")
   → Chave: `changeValue` → Entrada: o resultado da ação anterior.
   Repete para `changePct` e `totalToday` (3 ações "Obter Valor do
   Dicionário" no total, uma por cada chave).
5. Adiciona a ação **"Texto"** e escreve algo como:
   `Carteira: €[totalToday]\nHoje: €[changeValue] ([changePct]%)`
   — usa o botão de variável (ícone azul) dentro do campo de texto para
   inserires os valores que foste buscar no passo 4, em vez de escreveres
   os nomes à mão.
6. Adiciona a ação final **"Mostrar Resultado"** ("Show Result") com esse
   texto.
7. Testa: toca em ▶ dentro do editor do Atalho — deve mostrar o resumo.

### 3. Adicionar ao mostrador do Apple Watch
1. No iPhone, abre a app **Watch** → o teu mostrador atual → **Editar**.
2. Escolhe um espaço de complicação → procura **"Atalhos"** na lista →
   escolhe o Atalho **"Carteira"** que criaste.
3. Prime a Coroa Digital para guardar.

**Nota sobre o visual:** isto mostra texto simples (sem o design escuro
com cores que me mostraste) — é a limitação da app Atalhos. Também só
atualiza uma vez por dia, ao fecho do mercado (mesmo momento do email),
já que é aí que o `summary.json` é atualizado. Se um dia quiseres o
visual idêntico ao card, com atualização ao toque, é isso que a opção de
app nativa (Xcode) permite.

