---
name: architecture
description: Generate and open the interactive architecture debugging diagram showing component connections through all layers.
---

# Architecture Diagram Skill

Generate and open the interactive architecture debugger diagram.

## Usage

Type `/architecture` to generate and open the diagram.

Options:
- `/architecture` - Generate full diagram and open in browser
- `/architecture sync` - Focus on sync-related components
- `/architecture auth` - Focus on authentication flow
- `/architecture email` - Focus on email integration

## Action

When invoked, run:

```bash
cd "$(git rev-parse --show-toplevel)" && \
python .claude/skills/architecture/generate_architecture.py && \
open docs/architecture/architecture-debug.html
```

For focused views:
```bash
python .claude/skills/architecture/generate_architecture.py --focus sync
```

## Features

The diagram includes:
- **7 Architecture Layers**: Components → Hooks → Services → IPC → Handlers → Backend → Storage
- **Click any node** to trace full connection chain
- **Sidebar** shows file paths and descriptions
- **Visual highlighting** of connected nodes
- **Auto-discovery** of new components, hooks, and services

## How It Works

The script scans:
1. `src/components/**/*.tsx` - React components
2. `src/hooks/*.ts` - Custom hooks
3. `src/services/*.ts` - Frontend services
4. `electron/preload.ts` - IPC bridges
5. `electron/*-handlers.ts` - Main process handlers
6. `electron/services/*.ts` - Backend services

Then parses imports to build the connection graph.
