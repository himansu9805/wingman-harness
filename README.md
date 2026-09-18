# Wingman Harness

A local, Ollama-backed agent harness with tool calling,
an Agent-Skills-style progressive disclosure system, and MCP server
support.

## What it does

A CLI chat loop backed by a ReAct-style LangGraph graph: the model
thinks, optionally calls a tool, the tool runs, and the result goes
back to the model — looping until it has a real answer. Three things
feed into what the model can do:

- **Local tools** — a calculator and a (mocked) weather lookup, just
  enough to exercise tool-calling without needing real APIs.
- **Skills** — markdown files under `skills/` that the model can pull
  in on demand for a specific kind of task (writing a haiku, drafting
  a commit message, whatever you add). It only sees a one-line
  description of each skill up front, and loads the full instructions
  only when a task actually needs them.
- **MCP servers** — point `mcp.config.json` at any MCP server and its
  tools show up alongside your local ones automatically.

## Setup

Make sure Ollama is running locally with a tool-calling-capable model
pulled:

```bash
ollama pull <name_of_model>
```

Create the .env file in the root of the project diectory with following
content:

```plaintext
OLLAMA_MODEL=<name_of_model>
OLLAMA_BASE_URL=http://localhost:11434
```

## Run it

```bash
npm run dev
```

Things worth trying:

- `what's 23 * 47?` — the calculator tool
- `what's the weather in Bengaluru?` — the (mocked) weather tool
- `write me a haiku about the monsoon` — watch it load the
  `haiku-writer` skill before answering
- Ask a couple of follow-up questions in the same session — state
  persists across turns via LangGraph's checkpointer

To build a standalone bundle instead of running through `tsx`:

```bash
npm run build
npm start
```
