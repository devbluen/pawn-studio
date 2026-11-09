# Pawn Studio — SA-MP / open.mp

> 🇺🇸 [Read in English](README.md)

Um ambiente completo de Pawn no VS Code:

- compilação a partir de **qualquer** arquivo;
- sintaxe e IntelliSense;
- error lens ao vivo;
- gerenciador de pacotes via GitHub, com faixas de versão, que instala plugins e includes de qualquer repositório;
- depuração do servidor com crashdetect.

A extensão está disponível em **Português (Brasil)** e **English**. Ela segue o idioma do VS Code, ou
você pode forçar um idioma com `pawnStudio.language`.

| Atalho | O que faz |
|---|---|
| **F5** / **Ctrl+Shift+B** | compila o gamemode/filterscript do arquivo aberto |
| **F6** | compila e inicia o servidor com o depurador |
| **F12** | vai para a definição (inclusive dentro das includes) |
| **Ctrl+Espaço** | autocompletar com natives, stocks, defines e enums de toda a árvore de includes |

---

## Compilar de qualquer arquivo

A extensão lê os `#include` do projeto, ignorando os comentados, e descobre qual gamemode ou
filterscript usa o arquivo aberto, mesmo com vários níveis de módulos. A barra de status mostra o
alvo (`▶ GM: main.pwn` / `▶ FS: admin.pwn`) e o motivo da escolha.

Ordem de decisão:

1. alvo fixado (*Pawn: Fixar alvo de compilação*);
2. `// @entry ../gamemodes/main.pwn` no topo do arquivo;
3. o arquivo **é** um principal;
4. o único principal que inclui o arquivo; se forem vários, pergunta uma vez e lembra;
5. arquivo ainda não incluído por ninguém → último alvo, `entry` do `pawn.json` ou o único gamemode.

Um `.pwn` conta como **principal** quando:

- tem `main()` ou `#define FILTERSCRIPT`, **ou**
- está em `gamemodes/` ou `filterscripts/` e define `OnGameModeInit` / `OnFilterScriptInit`.

Um candidato que é incluído por outro principal deixa de ser principal. Assim, módulos com hook ALS
não são confundidos com gamemodes.

## Error lens ao vivo

Os erros aparecem **no fim da própria linha** enquanto você digita, sem precisar salvar. São duas
camadas:

1. **Análise rápida, a cada tecla (~20 ms)**, feita pela própria extensão. Aponta:
   - chave, parêntese ou colchete sem par;
   - string sem fechar;
   - `;` faltando (quando o projeto usa `-;+` / `#pragma semicolon 1`);
   - `#include` que não existe;
   - função indefinida, com sugestão (*você quis dizer "SetPlayerPos"?*);
   - número errado de argumentos.

   Ela entende multilinhas com `\`, macros de prefixo (`Dialog:`, `CMD:`, `Inventario:` → `IV_`),
   y_timers, `inline` e funções `static`.
2. **`pawncc` em segundo plano, sem salvar:**
   - compila uma cópia temporária do projeto que inclui o texto ainda não salvo;
   - em gamemodes grandes (YSI) isso leva o tempo do próprio `pawncc`, e a barra de status mostra
     `pawncc 12s` enquanto roda;
   - não é cancelado a cada tecla: fica em fila, e o resultado é ajustado às edições feitas enquanto
     compilava.

Os erros **acompanham o texto**: inserir linhas desloca os avisos, e editar uma linha com erro tira
o aviso na hora.

## Sintaxe e IntelliSense

- **Gramática completa:** tags (`Float:`), format specifiers (`%d`, `%s`, `{FF0000}`), packed strings,
  `#define` com `%0`, palavras do YSI (`hook`, `foreach`, `inline`, `timer`) e `CMD:`.
- **Autocompletar** a partir da árvore de includes do alvo, incluindo nomes de arquivo dentro de
  `#include <`.
- **Parâmetros preenchidos:** ao aceitar uma função com Tab ou Enter, ela vem com os parâmetros
  obrigatórios como campos, e o **Tab** pula de um para o outro:
  - `SetPlayerPos(playerid, x, y, z)`;
  - `GetPlayerName(playerid, name)` (o `len = sizeof name` tem valor padrão e fica de fora).

  Configuração: `pawnStudio.completion.parameters`.
- **Dicas de parâmetros**, **hover** com a documentação (os comentários XML da stdlib viram texto
  formatado), **F12**, **outline** e busca de símbolos.
- **54 snippets:** callbacks do SA-MP, dialogs, timers, comandos, enums, `foreach`, hooks…

## Gerenciador de pacotes (GitHub)

Funciona como o npm, com um formato próprio de `pawn.json`, e instala **qualquer** repositório do
GitHub.

O pacote não precisa ter sido feito para o Pawn Studio. Quando o repositório não tem `pawn.json`, a
extensão descobre sozinha:

- onde estão os `.inc` (`include/`, `pawno/include` ou a raiz do repositório);
- qual arquivo do **release** tem o plugin do seu sistema:
  - Windows: `-win32.zip`, `.dll`;
  - Linux: `-linux.tar.gz`, `.so`;
  - a versão 32 bits tem preferência sobre a de 64;
- o que é cada arquivo dentro do pacote:
  - **plugins** (`plugins/`) são copiados para `plugins/` e registrados na configuração do servidor;
  - **componentes do open.mp** (`components/`) são copiados para `components/`;
  - **bibliotecas** que o plugin precisa (por exemplo, `libmariadb.dll` e `log-core.dll` do MySQL)
    vão para a pasta do executável do servidor.

### Buscar e instalar

Na barra lateral Pawn, abra **Pacotes** e clique em `+`:

- a busca vai direto ao GitHub (repositórios com o tópico `pawn-package`, mais os repositórios de
  SA-MP);
- você escolhe a versão:
  - `^2.9.6` (recomendado): recebe atualizações compatíveis;
  - uma versão exata;
  - uma branch.

### Ao instalar um pacote

- o código vai para `dependencies/`;
- plugins, componentes e bibliotecas vão para o servidor, como descrito acima;
- os plugins são registrados no `server.cfg` (SA-MP) ou no `config.json` (open.mp);
- as pastas de include entram no compilador e no IntelliSense, sem configurar nada;
- os pacotes que o próprio pacote lista no `pawn.json` dele também são instalados. Se o seu projeto
  pede outra versão do mesmo pacote, vale a do seu projeto.

### Atualizações

A visão mostra cada pacote em um destes estados:

- **✓**: atualizado.
- **`v2.9.4 → v2.9.6`**: há uma versão mais nova dentro da faixa do `pawn.json`. Atualizar é seguro.
- **`v2.9.6 · v3.0.0 disponível`**: existe uma versão **major** nova, fora da faixa. Atualizar
  pede confirmação, porque pode quebrar o seu código, e depois muda o `pawn.json` para `^3.0.0`.
- **não instalado**: o pacote está no `pawn.json`, mas falta em `dependencies/`.

### Arquivo de trava e remoção

- **`pawn-lock.json`:** guarda a tag e o commit exatos de cada pacote. Quem clonar o projeto recebe
  exatamente o mesmo código com **Instalar dependências do pawn.json**.
- **Remover:** apaga os arquivos, os plugins e as bibliotecas, tira o plugin do `server.cfg` e limpa
  as dependências que mais nada usa.

### Limites do GitHub

Sem login, o GitHub permite 60 requisições por hora e 10 buscas por minuto. *Pawn: Entrar no GitHub*
usa a conta já conectada ao VS Code e sobe o limite para 5000 por hora.

---

## Como criar o `pawn.json`

O `pawn.json` fica na **raiz do servidor** (a pasta que contém `gamemodes/`). Ele diz à extensão:

- qual arquivo é o gamemode;
- onde gravar o `.amx`;
- quais pacotes o projeto usa, e em quais versões.

### Opção 1 — pelo comando (recomendado)

1. Abra a pasta do servidor no VS Code.
2. Rode **Pawn: Criar pawn.json** pela paleta de comandos (`Ctrl+Shift+P`), ou clique em **Criar
   pawn.json** na visão *Pacotes*.
3. O arquivo é criado com o gamemode detectado:

```json
{
	"name": "meu-servidor",
	"version": "1.0.0",
	"entry": "gamemodes/main.pwn",
	"output": "gamemodes/main.amx",
	"dependencies": {}
}
```

Você não precisa escrever as dependências à mão. Ao instalar um pacote com **Instalar pacote...**, a
extensão o adiciona em `dependencies` com a versão escolhida.

### Opção 2 — à mão

Crie um arquivo `pawn.json` na raiz do servidor. O editor valida e autocompleta os campos enquanto
você digita.

```json
{
	"name": "meu-servidor",
	"version": "1.0.0",
	"entry": "gamemodes/main.pwn",
	"output": "gamemodes/main.amx",
	"dependencies": {
		"samp-incognito/samp-streamer-plugin": "^2.9.6",
		"pBlueG/SA-MP-MySQL": "^R41-4",
		"pawn-lang/YSI-Includes": "branch:5.x"
	},
	"devDependencies": {
		"AmyrAhmady/samp-plugin-crashdetect": "^4.22"
	}
}
```

Depois rode **Pawn: Instalar dependências do pawn.json** (ou o botão ☁ na visão *Pacotes*).

### Campos

| Campo | Obrigatório | Descrição |
|---|---|---|
| `name` | não | nome do projeto |
| `version` | não | versão do projeto (para a sua referência) |
| `entry` | recomendado | arquivo `.pwn` principal, relativo ao `pawn.json` |
| `output` | não | `.amx` a gerar (padrão: ao lado do `.pwn`) |
| `dependencies` | não | `{ "usuario/repo": "versão" }`: pacotes do GitHub (veja as versões abaixo) |
| `devDependencies` | não | mesmo formato; pacotes usados só no desenvolvimento (ex.: crashdetect) |
| `include` | só pacotes | pasta(s) com os `.inc` que você exporta |
| `plugins` | só pacotes | qual arquivo do release tem os binários, por sistema |

### Versões

A chave é o repositório no GitHub (`usuario/repo`). O valor diz qual versão instalar.

| Valor | Instala |
|---|---|
| `"^2.9.6"` | a versão **2.x.x** mais nova que seja no mínimo 2.9.6 (padrão ao instalar) |
| `"~2.9.6"` | a versão **2.9.x** mais nova (só correções) |
| `"2.9.6"` | exatamente a 2.9.6 (a tag `v2.9.6` ou `2.9.6`) |
| `"2.x"`, `">=1.2 <2"`, `"^1 \|\| ^2"` | qualquer versão dentro da faixa |
| `"latest"` | a versão mais nova (ou a branch padrão, se o repositório não tiver tags) |
| `"tag:r1-final"` | uma tag pelo nome exato, para tags que não são números de versão |
| `"branch:dev"` | o commit mais novo da branch (o commit fica travado no `pawn-lock.json`) |
| `"commit:a1b2c3d"` | exatamente esse commit |

Funcionam tags nos estilos `v1.2.3` e `1.2.3`, e também o estilo do SA-MP `R41-4`, lido como `41.4`.
Pré-lançamentos (`-beta`, `-rc1`) só são instalados quando a versão que você pede cita um.

### O que vai para o git

- ✅ `pawn.json` e `pawn-lock.json`: quem clonar o projeto recebe as mesmas versões com *Instalar
  dependências do pawn.json*.
- ❌ `dependencies/`: é baixada de novo. Coloque no `.gitignore`.

### Publicar o seu próprio pacote

Para uma include, normalmente não precisa de nada. Suba o repositório e crie tags (`v1.0.0`): a
extensão encontra os `.inc` sozinha. Adicione o tópico **`pawn-package`** ao repositório para ele
aparecer na busca.

Para um plugin, anexe os builds a um **release** do GitHub, com o sistema no nome:

- `meuplugin-1.0.0-win32.zip`, com `plugins/meuplugin.dll` dentro (e `pawno/include/meuplugin.inc`, se
  a include só existir no release);
- `meuplugin-1.0.0-linux.tar.gz`, com `plugins/meuplugin.so` dentro.

Coloque um `pawn.json` no **seu** repositório só quando precisar declarar dependências ou mudar a
detecção automática:

```json
{
	"name": "meuplugin",
	"version": "1.0.0",
	"include": "include",
	"plugins": {
		"windows": "meuplugin-*-win32.zip",
		"linux": "meuplugin-*-linux.tar.gz"
	},
	"dependencies": {
		"pawn-lang/samp-stdlib": "latest"
	}
}
```

- `include`: pasta (ou lista de pastas) com os `.inc`. Deixe de fora para usar a detecção.
- `plugins`:
  - um padrão (`*` = qualquer coisa) para o arquivo do release de cada sistema;
  - `false` para um pacote que nunca tem binários;
  - deixe de fora para usar a detecção.
- `dependencies`: o que o seu pacote precisa. É instalado junto com ele.
- Dentro do arquivo do release:
  - binários em `plugins/` são plugins;
  - binários em `components/` são componentes do open.mp;
  - qualquer outro `.dll`/`.so` é uma biblioteca que vai para a pasta do executável do servidor.

---

## Depurar o servidor

**F6**, o botão ▶ da aba *Servidor* ou Executar e Depurar → *Servidor SA-MP / open.mp*:

1. compila o gamemode (e para se houver erro);
2. avisa se o `server.cfg` carrega outro gamemode;
3. inicia o `samp-server.exe` / `omp-server.exe` e mostra o log ao vivo no **Console de Depuração**;
4. quando o **crashdetect** acusa um erro (índice fora do array, função nativa falhou, travamento…):
   - o VS Code **para na linha exata** com a mensagem do erro e uma dica;
   - a **pilha de chamadas** mostra cada função com arquivo e linha;
   - a aba **Variáveis** mostra os argumentos de cada função (`playerid = 0`, `cmdtext = "/teste"`);
   - o servidor continua rodando: **Continuar (F5)** segue em frente;
5. o **REPL** do Console de Depuração manda comandos ao servidor: via RCON no SA-MP (precisa de
   `rcon_password`), pelo console no open.mp.

> O SA-MP não permite breakpoints nem execução passo a passo. O depurador mostra **onde** e
> **por que** o erro aconteceu. Instale o crashdetect (busque "crashdetect" em Pacotes) e mantenha
> `-d3` nos argumentos do compilador.

## Barra lateral "Pawn"

- **Compilação:**
  - resultado da última compilação ou verificação, com tempo e horário;
  - alvo e tamanho do `.amx`;
  - erros e avisos clicáveis;
  - compilador e pastas de include.
- **Pacotes:** dependências diretas e indiretas, com o estado de cada uma (instalado, atualizado,
  atualização disponível, faltando), plugins e include paths; ações inline.
- **Servidor:**
  - rodando ou parado;
  - executável (SA-MP ou open.mp), `server.cfg`, gamemode e porta;
  - log do servidor;
  - plugins, avisando quando um arquivo está faltando em `plugins/`;
  - histórico de **erros em execução** com a pilha de chamadas clicável.

## Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `pawnStudio.language` | `auto` | idioma da extensão (`auto`, `en`, `pt-br`) |
| `pawnStudio.compilerPath` | `""` | caminho do `pawncc` (vazio = automático) |
| `pawnStudio.includePaths` | `[]` | pastas extras de include |
| `pawnStudio.args` | `["-;+", "-(+", "-d3"]` | argumentos do compilador |
| `pawnStudio.outputDirectory` | `""` | pasta do `.amx` |
| `pawnStudio.entry` | `""` | alvo fixo |
| `pawnStudio.saveBeforeCompile` | `true` | salvar antes de compilar |
| `pawnStudio.lint.quick` | `true` | análise rápida enquanto digita |
| `pawnStudio.lint.onType` | `true` | `pawncc` em segundo plano sem salvar |
| `pawnStudio.lint.delay` | `1500` | ms parado antes de chamar o `pawncc` |
| `pawnStudio.lintOnSave` | `true` | verificação em segundo plano ao salvar |
| `pawnStudio.completion.parameters` | `required` | parâmetros inseridos pelo autocompletar |
| `pawnStudio.revealOutput` | `onError` | quando mostrar a saída |
| `pawnStudio.errorLens.*` | — | error lens (ativar, avisos, outras linguagens) |
| `pawnStudio.server.path` | `""` | `samp-server.exe` / `omp-server.exe` |
| `pawnStudio.packages.checkUpdatesOnStartup` | `true` | verificar atualizações ao abrir |

## Desenvolvimento

```
npm install
npm test            # testes unitários + gramática + traduções
npm run test:live   # integração real com o GitHub (instala crashdetect + streamer numa pasta temporária)
npm run test:vscode -- <pawncc.exe> <pasta-include>...   # abre um VS Code real e testa tudo
npm run package     # gera o .vsix
```

### Traduções

- As mensagens do código usam `t('English text {0}', valor)` (`src/i18n.ts`). As traduções ficam em
  `l10n/bundle.l10n.<idioma>.json`.
- Menus e configurações usam `package.nls.json` / `package.nls.<idioma>.json`.
- O `npm test` falha se alguma mensagem ficar sem tradução ou com placeholders diferentes.
- Para adicionar um idioma, copie os arquivos `pt-br`, traduza e inclua o idioma na configuração
  `pawnStudio.language`.
