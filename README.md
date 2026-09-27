# 🧠 AI Brain — Personal AI OS locale

Un cervello digitale 3D che gira **interamente sul tuo PC**: migliaia di neuroni vivi, cluster per progetti, task, memoria e strumenti, e un **agente di coding autonomo** che legge e modifica codice, usa il terminale, esegue i test, corregge gli errori e ti mostra in tempo reale cosa sta facendo. Niente API a pagamento: usa un LLM open‑source locale tramite Ollama o llama.cpp.

![AI Brain al lavoro](docs/images/brain-working.png)

| Idle | Conferma prima di un'azione rischiosa |
|---|---|
| ![idle](docs/images/brain-idle.png) | ![approval](docs/images/brain-approval.png) |

---

## Cosa fa (V1)

**Cervello 3D**
- ~12.000 neuroni a forma di cervello (due emisferi, cervelletto, tronco) con sinapsi; impulsi che corrono sulle sinapsi, tutto animato su GPU
- cluster semantici: **nucleo**, 8 **lobi strumenti** (filesystem, ricerca, terminale, git, test, web, memoria, pianificazione), **progetti** con i loro **moduli**, **task** e **ricordi**
- quando l'agente lavora gli impulsi viaggiano nucleo → lobo dello strumento → progetto → task; il campo neurale si accende in base all'attività
- camera cinematografica (volo morbido verso i nodi, auto‑rotazione a riposo), bloom, tema scuro/chiaro
- click su un nodo = ci entri (pannello di dettaglio); pannelli minimal che compaiono solo quando servono

**Agente**
- legge/crea/modifica/elimina file, analizza l'intera codebase (indice con linguaggi, framework, simboli), cerca nel codice (ripgrep)
- usa il terminale, esegue i test (auto‑rilevati: npm/pnpm/yarn, pytest, cargo, go, dotnet, make), usa Git (status/diff/log/branch/commit — **mai push**)
- web search + lettura pagine (senza API key)
- ciclo autonomo multi‑step: **analizza → pianifica → modifica → testa → correggi → verifica → report**; se modifica file senza verificarli, l'orchestratore lo obbliga a farlo
- **chiede conferma** prima di azioni rischiose (eliminazioni, comandi non banali, commit); le azioni distruttive chiedono *sempre*
- **ogni modifica è annullabile**: snapshot automatico dei file prima di toccarli → pulsante “Annulla modifiche”
- memoria persistente di progetti, decisioni, fatti, idee, preferenze e task (le richieste successive ne tengono conto)
- streaming live di pensieri, piano, strumenti, output del terminale

---

## Modello e runtime scelti per il tuo hardware

**Hardware:** Ryzen 7 5800X · RX 6650 XT 8 GB · 64 GB RAM.

| Ruolo | Modello (Ollama) | Perché |
|---|---|---|
| **Principale** | `qwen3-coder:30b` (Qwen3‑Coder‑30B‑A3B, ~19 GB Q4) | Modello *specializzato in coding agentico* con tool‑calling nativo. È un **MoE**: 30B parametri ma solo ~3B attivi per token, quindi pur non entrando negli 8 GB di VRAM gira bene con parte dei pesi nei tuoi 64 GB di RAM. Il miglior rapporto qualità/velocità per il tuo PC. |
| Veloce (opzionale) | `qwen3:8b` (~5 GB) | Sta tutto in VRAM → molto più rapido per domande e task semplici. Provider `ollama-fast`. |
| Alternativa | `gpt-oss:20b` | Altro MoE forte nel tool‑calling, se vuoi confrontare. |

**Runtime: Ollama** (default) — semplice, gestisce download/quantizzazione e offload GPU+CPU da solo, API con tool‑calling nativo. **llama.cpp** (`llama-server`, build *Vulkan*) è supportato come alternativa tramite il provider `llama-cpp` (API OpenAI‑compatibile) se vuoi il massimo controllo (es. `--n-cpu-moe`).

> **GPU AMD su Windows.** La RX 6650 XT (gfx1032) non è supportata ufficialmente da ROCm su Windows; Ollama la usa tramite **Vulkan**. Nelle versioni 0.30.x c'è un bug noto per cui il loader Vulkan incluso in Ollama non vede la 6650 XT e tutto gira su CPU ([ollama/ollama#16677](https://github.com/ollama/ollama/issues/16677)). Controlla con `npm run doctor` (mostra la % del modello in VRAM) o `ollama ps`. Se vedi `100% CPU`, il workaround è far usare a Ollama il loader Vulkan di sistema (da ripetere dopo ogni aggiornamento di Ollama):
> ```powershell
> Rename-Item "$env:LOCALAPPDATA\Programs\Ollama\lib\ollama\vulkan\vulkan-1.dll" "vulkan-1.dll.bak"
> ```
> In alternativa usa la build Vulkan di llama.cpp (vedi sotto).

---

## Installazione (Windows)

1. **Node.js 22 LTS** — https://nodejs.org · **Git** — https://git-scm.com
   Consigliato: **ripgrep** per ricerche veloci → `winget install BurntSushi.ripgrep.MSVC`
2. **Ollama** — https://ollama.com/download, poi in un terminale:
   ```powershell
   ollama pull qwen3-coder:30b
   ollama pull qwen3:8b          # opzionale, modello veloce
   ```
   Opzionale ma utile per risparmiare memoria del contesto (variabili d'ambiente di sistema, poi riavvia Ollama):
   `OLLAMA_FLASH_ATTENTION=1` e `OLLAMA_KV_CACHE_TYPE=q8_0`.
3. **AI Brain**
   ```powershell
   git clone <questo repo> ai-brain
   cd ai-brain
   npm install
   npm run doctor     # verifica Node, git, ripgrep, Ollama, modello, uso GPU
   ```
4. **Avvio**
   - sviluppo (hot reload): `npm run dev` → si apre http://127.0.0.1:5173
   - uso quotidiano: doppio click su **`AI-Brain.cmd`** (compila la prima volta e apre http://127.0.0.1:7777), oppure `npm run build && npm start`

Funziona anche su Linux/macOS con gli stessi comandi.

### Usare llama.cpp invece di Ollama
Scarica una release di llama.cpp *win-vulkan*, poi ad esempio:
```powershell
llama-server -m Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf --jinja -c 32768 -ngl 99 --n-cpu-moe 30 --port 8080
```
e in **Impostazioni → Provider** scegli `llama-cpp` (oppure `"active": "llama-cpp"` in `brain.config.json`).

---

## Come si usa

1. **+ Progetto** → scegli la cartella del progetto. Diventa un cluster nel cervello e viene indicizzato.
2. Scrivi nella barra in basso, es. *«Analizza il mio progetto e sistema il combat system.»*
3. Nel pannello a destra vedi in tempo reale piano, ragionamenti, strumenti usati e output del terminale; nel 3D gli impulsi mostrano dove sta lavorando.
4. Se l'agente vuole fare qualcosa di rischioso compare una **richiesta di conferma** (Nega / Consenti / Consenti per questa esecuzione).
5. Alla fine trovi il **report** con file modificati e verifica eseguita. **↶ Annulla modifiche** ripristina i file; **↳ Continua questo task** manda un follow‑up con il contesto del task.

**Comandi:** trascina = ruota · scroll = zoom · click su nodo = entra · doppio click sul vuoto = torna · `/` = scrivi · `Esc` = chiudi · `T` = tema.

**Autonomia** (Impostazioni): per ogni classe di azione scegli `auto`, `chiedi` o `solo rischiosi`. Default: modifiche ai file automatiche (annullabili), eliminazioni e commit su conferma, terminale su conferma tranne build/test/comandi di sola lettura, test automatici.

---

## Architettura

```
 3D UI (three.js + Vite)          ── WebSocket eventi live / REST ──►  AI Orchestrator
   scene: campo neurale, grafo,                                        (loop agentico, piano, verifica,
   impulsi, camera; pannelli                                            approvazioni, checkpoint, contesto)
                                                                            │            │
                                                            LLM Router ◄────┘            └────► Tool Registry
                                                  (provider sostituibili + fallback)          filesystem · search/index
                                                  Ollama │ OpenAI‑compatibile                  terminal · tests · git
                                                  (llama.cpp, LM Studio, cloud)               web · memory · planning
                                                                                                    │
                                                                    Memory / Project Index ◄────────┘
                                                             (~/.ai-brain: progetti, task, ricordi, run log,
                                                              checkpoint; indice codebase con simboli)
```

Dettagli, flusso degli eventi e come estendere (nuovi strumenti, nuovi provider, modello cloud di fallback): **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Aggiungere un modello cloud come fallback (senza toccare il codice)
In `brain.config.json` (copia da `brain.config.example.json`):
```json
{
  "llm": {
    "active": "ollama",
    "fallbacks": ["cloud"],
    "providers": {
      "cloud": { "type": "openai", "baseUrl": "https://api.provider.com/v1", "model": "nome-modello", "apiKeyEnv": "CLOUD_API_KEY", "contextTokens": 128000 }
    }
  }
}
```
La chiave si legge solo dalla variabile d'ambiente indicata, mai da file. Se Ollama non risponde, il router passa al fallback e la UI lo segnala.

---

## Sicurezza

- server in ascolto **solo su 127.0.0.1**; richieste con `Origin`/`Host` estranei rifiutate (protegge da siti web malevoli e DNS‑rebinding)
- l'agente è **confinato nella cartella del progetto** (niente `..`, percorsi assoluti esterni o symlink che escono)
- comandi classificati: build/test/lettura → ok; il resto → conferma; distruttivi (`rm -rf`, `git push`, `reset --hard`, `format`, `curl | sh`…) → **sempre** conferma, evidenziati in rosso
- snapshot per‑esecuzione di ogni file toccato → annullabile anche senza git
- i comandi girano non interattivi, con timeout e kill dell'intero albero di processi all'annullamento

## Dati

Tutto in `~/.ai-brain` (configurabile): `brain.json` (progetti, task, ricordi, esecuzioni), `runs/*.jsonl` (log eventi per rivedere un'esecuzione), `checkpoints/` (snapshot per l'undo), `settings.json` (impostazioni dalla UI), `scratch/` (cartella di lavoro quando non è selezionato un progetto).

## Sviluppo

```bash
npm test            # 26 test: unità, provider (server Ollama/OpenAI finti), agente end-to-end, API/WebSocket
npm run typecheck
npm run build
```

```
server/src/
  llm/        types.ts (contratto), ollama.ts, openai.ts, router.ts (fallback), util.ts (parser tool-call testuali)
  agent/      orchestrator.ts (loop), prompts.ts, context.ts (compattazione), approvals.ts
  tools/      filesystem, search, terminal (+ process.ts), git, web, brain (plan/memoria), registry.ts (policy)
  workspace/  workspace.ts (sandbox/ignore), indexer.ts (indice codebase), checkpoint.ts (undo)
  memory/     store.ts (memoria persistente)
  api/        server.ts (REST + WS + static), graph.ts (grafo per il 3D)
web/src/
  scene/      brain.ts (renderer/camera/bloom), field.ts (neuroni+sinapsi), graph.ts (nodi/archi/label/picking), pulses.ts
  ui/         activity.ts (live), detail.ts (nodo), modals.ts (progetto/impostazioni), dom.ts
  app.ts      eventi → UI + coreografia 3D
```

## Limiti noti della V1 e prossimi passi

- La qualità dell'agente dipende dal modello locale: su task molto ampi un 30B locale è meno affidabile di un modello cloud di punta — per questo c'è il fallback cloud opzionale e il limite di passi configurabile.
- La ricerca in memoria è per parole chiave (IDF + recenza); prossimo passo: embeddings locali (`nomic-embed-text` via Ollama).
- Nessun test headless per i motori di gioco (Unity/Unreal/Godot): l'agente verifica con build/compilazione quando possibile e dice cosa testare a mano.
- Roadmap: app desktop (Electron/Tauri), più agenti in parallelo, diff viewer, voce, indicizzazione incrementale con file watcher.
