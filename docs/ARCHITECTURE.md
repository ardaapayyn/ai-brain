# Architettura di AI Brain

## Livelli

```
┌──────────────────────────── web/ (browser) ────────────────────────────┐
│ BrainScene (three.js)            App (controller)        Pannelli DOM   │
│  NeuralField  GraphLayer          eventi → stato →        Activity      │
│  PulseLayer   camera/bloom        coreografia 3D          Detail/Modals │
└──────────────▲───────────────────────────┬──────────────────────────────┘
               │ WebSocket /ws (BrainEvent) │ REST /api/*
┌──────────────┴───────────────────────────▼──────────── server/ ─────────┐
│ api/server.ts   (localhost only, controllo Origin/Host, static web/dist)│
│        │                                                                │
│ agent/Orchestrator ── EventBus ── (log su disco runs/*.jsonl)           │
│   │  loop: LLM → tool calls → approvazioni → esecuzione → risultati     │
│   │  compattazione contesto · nudge di verifica · anti-loop · cancel    │
│   ├── llm/LLMRouter ── OllamaProvider | OpenAICompatProvider (+fallback)│
│   ├── tools/ToolRegistry ── needsApproval(policy) ── Tool.execute(ctx)  │
│   ├── workspace/ Workspace (sandbox) · Indexer · Checkpoint (undo)      │
│   └── memory/MemoryStore (progetti, task, ricordi, run)                 │
└─────────────────────────────────────────────────────────────────────────┘
```

Ogni livello dipende solo da interfacce del livello sotto:
- l'orchestratore conosce `LLMProvider` (llm/types.ts), non Ollama;
- i tool ricevono un `ToolContext` (workspace confinato, memoria, checkpoint, segnale di annullamento) e non sanno nulla di HTTP o UI;
- la UI conosce solo `BrainEvent` e le rotte REST.

## Il loop dell'agente (`agent/orchestrator.ts`)

1. **Contesto iniziale**: system prompt (`prompts.ts`) con istruzioni di metodo (ANALYZE → PLAN → IMPLEMENT → VERIFY → FIX → REPORT), ambiente (OS, shell), snapshot dell'indice del progetto, ricordi rilevanti (`MemoryStore.searchMemories`), storia condensata del task e piano corrente.
2. **Per ogni step** (max `agent.maxSteps`):
   - compatta la conversazione se supera ~75% della finestra del modello (`context.ts`: prima accorcia vecchi output dei tool, poi elimina gruppi assistant+tool interi mantenendo valide le coppie call/result);
   - chiama l'LLM in streaming (token → evento `llm.token`);
   - se ci sono tool call: valida argomenti, applica la **policy di approvazione**, esegue, invia l'output al modello; errori (sandbox, argomenti mancanti, tool sconosciuti) tornano al modello come risultati recuperabili;
   - se non ci sono tool call è la risposta finale — tranne se il modello ha modificato file senza verificarli: allora riceve un *nudge* e deve eseguire test/build.
3. **Chiusura**: stato del task, riepilogo, file toccati, storia; evento `run.finished`.

Robustezza per modelli locali:
- parser di tool call testuali (`<tool_call>{json}</tool_call>`, XML stile Qwen `<function=…>`, JSON in blocchi di codice) quando il runtime non restituisce chiamate strutturate;
- riparazione di JSON con virgole finali;
- `edit_file` tollera differenze di indentazione e CRLF;
- rilevamento di chiamate ripetute identiche;
- avviso a 2 step dal limite.

## Approvazioni (`tools/registry.ts`, `agent/approvals.ts`)

Ogni tool dichiara una classe di rischio (`fileWrite`, `fileDelete`, `shell`, `tests`, `git`, `network` o `none`), eventualmente dipendente dagli argomenti (es. `run_tests` con comando custom → `shell`). La policy configurata (`auto` | `ask` | `ask-risky`) decide; `isDangerous()` forza sempre la conferma. L'orchestratore attende la risposta della UI (WS o HTTP); “Consenti per questa esecuzione” vale per quel tool fino alla fine della run, mai per azioni distruttive.

## Eventi (`events.ts`)

`run.started` · `run.status` (thinking/tool/waiting_approval/verifying) · `llm.token` · `llm.thinking` · `llm.message` · `tool.started` · `tool.output` (stream del terminale) · `tool.finished` · `plan.updated` · `approval.requested/resolved` · `memory.added` · `graph.changed` · `llm.fallback` · `run.finished`.

La UI usa lo stesso reducer (`web/src/state.ts → applyEvent`) sia per lo streaming live sia per rivedere run passate dai log `runs/<id>.jsonl`.

## Grafo 3D (`api/graph.ts` → `web/src/scene/graph.ts`)

Nodi: `core`, `tool:<categoria>`, progetti, moduli (cartelle di primo livello dall'indice), task, ricordi. Il layout è deterministico (stesso grafo → stesse posizioni): progetti su un anello/sfera di Fibonacci attorno al nucleo, figli su gusci per tipo attorno al proprio progetto; i nodi nuovi nascono dal genitore e scivolano in posizione. Il picking è in screen‑space (robusto con migliaia di punti). Gli impulsi seguono curve di Bézier tra nodi in movimento.

## Estendere

**Nuovo strumento** — crea un oggetto `Tool` (vedi `tools/types.ts`) e aggiungilo in `defaultTools()`:
```ts
export const lintTool: Tool = {
  name: 'run_lint', category: 'tests', description: 'Run the linter',
  parameters: { type: 'object', properties: {} },
  risk: 'tests',
  summarize: () => 'lint',
  async execute(_args, ctx) { /* ctx.workspace, ctx.signal, ctx.onOutput … */ return { ok: true, output: '…' }; },
};
```

**Nuovo provider LLM** — implementa `LLMProvider` (`chat`, `health`, `listModels`) e registralo in `createProvider()` (`llm/router.ts`). Qualsiasi server OpenAI‑compatibile funziona già con `type: "openai"`.

**Memoria semantica** — `MemoryStore.searchMemories` è l'unico punto di retrieval: si può sostituire con embeddings (es. `nomic-embed-text` via Ollama) senza toccare orchestratore o UI.
