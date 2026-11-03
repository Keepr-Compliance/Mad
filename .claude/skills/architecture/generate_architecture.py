#!/usr/bin/env python3
"""
Architecture Diagram Generator for Magic Audit

Scans the codebase to discover components, hooks, services, and their connections,
then generates an interactive HTML debugging diagram.
"""

import os
import re
import json
import argparse
from pathlib import Path
from typing import Dict, List, Set, Optional
from dataclasses import dataclass, field

# Repo root: .claude/skills/architecture/<this file> -> parents[3]
BASE_DIR = Path(__file__).resolve().parents[3]
assert (BASE_DIR / "package.json").exists(), f"repo root not found at {BASE_DIR}"

@dataclass
class ArchNode:
    id: str
    name: str
    layer: str
    file: str
    desc: str = ""
    connects: List[str] = field(default_factory=list)

class ArchitectureScanner:
    def __init__(self, focus: Optional[str] = None):
        self.focus = focus
        self.nodes: Dict[str, ArchNode] = {}

        # Layer definitions
        self.layers = {
            'components': {'color': '#3fb950', 'label': 'Components', 'desc': 'React UI'},
            'hooks': {'color': '#39c5cf', 'label': 'Hooks', 'desc': 'State & Logic'},
            'services': {'color': '#a371f7', 'label': 'Services', 'desc': 'Frontend'},
            'ipc': {'color': '#d29922', 'label': 'IPC Bridge', 'desc': 'window.api.*'},
            'handlers': {'color': '#db61a2', 'label': 'Handlers', 'desc': 'Main Process'},
            'backend': {'color': '#58a6ff', 'label': 'Backend', 'desc': 'Electron Services'},
            'storage': {'color': '#f85149', 'label': 'Storage', 'desc': 'Data & APIs'},
        }

        # Focus filters
        self.focus_keywords = {
            'sync': ['sync', 'Sync', 'queue', 'Queue', 'refresh', 'Refresh', 'iPhone', 'iphone', 'device', 'Device'],
            'auth': ['auth', 'Auth', 'login', 'Login', 'oauth', 'OAuth', 'token', 'Token', 'session', 'Session'],
            'email': ['email', 'Email', 'gmail', 'Gmail', 'outlook', 'Outlook', 'mail', 'Mail', 'graph', 'Graph'],
        }

    def should_include(self, name: str, file: str) -> bool:
        """Check if node should be included based on focus filter."""
        if not self.focus:
            return True
        keywords = self.focus_keywords.get(self.focus, [])
        text = f"{name} {file}".lower()
        return any(kw.lower() in text for kw in keywords)

    def scan_components(self):
        """Scan React components."""
        components_dir = BASE_DIR / "src" / "components"
        if not components_dir.exists():
            return

        # Key components to always include
        key_components = [
            ("Dashboard", "Dashboard.tsx", "Main dashboard view with sync status and navigation"),
            ("SyncStatusIndicator", "dashboard/SyncStatusIndicator.tsx", "Shows sync progress for contacts, emails, messages"),
            ("ConversationList", "ConversationList/index.tsx", "Displays email and message conversations"),
            ("Contacts", "Contacts.tsx", "Contact management view"),
            ("Login", "Login.tsx", "Google OAuth login screen"),
            ("MicrosoftLogin", "MicrosoftLogin.tsx", "Microsoft OAuth login screen"),
            ("AuditTransactionModal", "AuditTransactionModal.tsx", "Transaction audit dialog"),
            ("OnboardingFlow", "OnboardingFlow.tsx", "Multi-step onboarding sequence"),
        ]

        for name, file, desc in key_components:
            if self.should_include(name, file):
                full_path = components_dir / file
                if full_path.exists() or (components_dir / file.split('/')[0]).exists():
                    self.nodes[name] = ArchNode(
                        id=name,
                        name=name,
                        layer='components',
                        file=f"src/components/{file}",
                        desc=desc
                    )

    def scan_hooks(self):
        """Scan custom hooks."""
        hooks_dir = BASE_DIR / "src" / "hooks"
        if not hooks_dir.exists():
            return

        key_hooks = [
            ("useAppStateMachine", "useAppStateMachine.ts", "Central state orchestrator for app lifecycle", "src/appCore/state"),
            ("useSyncQueue", "useSyncQueue.ts", "React hook for SyncQueueService subscription", "src/hooks"),
            ("useAutoRefresh", "useAutoRefresh.ts", "Triggers sync operations on dashboard open", "src/hooks"),
            ("useIPhoneSync", "useIPhoneSync.ts", "Manages iPhone device detection and sync", "src/hooks"),
            ("useConversations", "useConversations.ts", "Loads and manages message conversations", "src/hooks"),
            ("useMacOSMessagesImport", "useMacOSMessagesImport.ts", "macOS Messages.app import", "src/hooks"),
            ("useAuditTransaction", "useAuditTransaction.ts", "Transaction audit workflow", "src/hooks"),
        ]

        for name, file, desc, path in key_hooks:
            if self.should_include(name, file):
                self.nodes[name] = ArchNode(
                    id=name,
                    name=name,
                    layer='hooks',
                    file=f"{path}/{file}",
                    desc=desc
                )

    def scan_frontend_services(self):
        """Scan frontend services."""
        services_dir = BASE_DIR / "src" / "services"
        if not services_dir.exists():
            return

        key_services = [
            ("SyncQueueService", "SyncQueueService.ts", "Singleton tracking sync state with completion detection"),
            ("authService", "authService.ts", "Wraps authentication IPC calls"),
            ("transactionService", "transactionService.ts", "Wraps transaction IPC calls"),
            ("contactService", "contactService.ts", "Wraps contact IPC calls"),
            ("deviceService", "deviceService.ts", "Device detection and iPhone sync"),
            ("licenseService", "licenseService.ts", "License validation"),
        ]

        for name, file, desc in key_services:
            if self.should_include(name, file):
                self.nodes[name] = ArchNode(
                    id=name,
                    name=name,
                    layer='services',
                    file=f"src/services/{file}",
                    desc=desc
                )

    def scan_ipc_bridges(self):
        """Scan IPC bridges from preload."""
        bridges = [
            ("syncBridge", "window.api.sync", "iPhone sync operations"),
            ("transactionBridge", "window.api.transactions", "Scan, CRUD, export"),
            ("contactBridge", "window.api.contacts", "Contact operations"),
            ("messageBridge", "window.api.messages", "macOS iMessage import"),
            ("authBridge", "window.api.auth", "OAuth login/logout"),
            ("outlookBridge", "window.api.outlook", "Outlook email operations"),
            ("deviceBridge", "window.api.device", "Device detection"),
            ("llmBridge", "window.api.llm", "LLM configuration"),
        ]

        for name, api, desc in bridges:
            if self.should_include(name, api):
                self.nodes[name] = ArchNode(
                    id=name,
                    name=name,
                    layer='ipc',
                    file=f"electron/preload.ts → {name}",
                    desc=f"{api}.* - {desc}"
                )

    def scan_handlers(self):
        """Scan main process handlers."""
        handlers_dir = BASE_DIR / "electron"

        key_handlers = [
            ("syncHandlers", "sync-handlers.ts", "Handles sync:start, sync:cancel, sync:getStatus"),
            ("transactionHandlers", "transaction-handlers.ts", "Handles transactions:scan, CRUD operations"),
            ("contactHandlers", "contact-handlers.ts", "Handles contacts:getAll, link, sync"),
            ("messageHandlers", "handlers/messageImportHandlers.ts", "Handles messages:importMacOSMessages"),
            ("authHandlers", "auth-handlers.ts", "Handles OAuth login for Google/Microsoft"),
            ("deviceHandlers", "device-handlers.ts", "Handles device detection"),
            ("llmHandlers", "llm-handlers.ts", "Handles LLM configuration"),
        ]

        for name, file, desc in key_handlers:
            if self.should_include(name, file):
                self.nodes[name] = ArchNode(
                    id=name,
                    name=name.replace('Handlers', '-handlers'),
                    layer='handlers',
                    file=f"electron/{file}",
                    desc=desc
                )

    def scan_backend_services(self):
        """Scan backend Electron services."""
        key_services = [
            ("syncOrchestrator", "syncOrchestrator.ts", "Orchestrates full iPhone sync pipeline"),
            ("gmailFetchService", "gmailFetchService.ts", "Fetches emails from Gmail API with rate limiting"),
            ("outlookFetchService", "outlookFetchService.ts", "Fetches emails from Microsoft Graph API"),
            ("deviceDetectionService", "deviceDetectionService.ts", "Detects connected iPhones via libimobiledevice"),
            ("backupService", "backupService.ts", "Creates encrypted iPhone backups via idevicebackup2"),
            ("iOSMessagesParser", "iOSMessagesParser.ts", "Extracts SMS/iMessage from iPhone backup"),
            ("macOSMessagesImport", "macOSMessagesImportService.ts", "Reads macOS Messages.app database directly"),
            ("iPhoneSyncStorage", "iPhoneSyncStorageService.ts", "Persists sync results to local database"),
            ("databaseService", "databaseService.ts", "SQLite facade with SQLCipher encryption"),
            ("supabaseService", "supabaseService.ts", "Cloud sync operations"),
            ("tokenEncryptionService", "tokenEncryptionService.ts", "OAuth token encryption via safeStorage"),
        ]

        for name, file, desc in key_services:
            if self.should_include(name, file):
                self.nodes[name] = ArchNode(
                    id=name,
                    name=name,
                    layer='backend',
                    file=f"electron/services/{file}",
                    desc=desc
                )

    def scan_storage(self):
        """Add storage and external API nodes."""
        storage_nodes = [
            ("sqlite", "SQLite + SQLCipher", "Local encrypted database", "Encrypted local DB. Tables: users, contacts, messages, transactions"),
            ("supabase", "Supabase", "Cloud database", "User profiles, devices, API quotas. RLS enforced."),
            ("gmailApi", "Gmail API", "External API", "Gmail API via OAuth 2.0. Scopes: mail.readonly"),
            ("graphApi", "MS Graph API", "External API", "Microsoft Graph API. Scopes: Mail.Read"),
            ("libimobiledevice", "libimobiledevice", "Native library", "iPhone communication via USB"),
        ]

        for id, name, file, desc in storage_nodes:
            if self.should_include(name, desc):
                self.nodes[id] = ArchNode(
                    id=id,
                    name=name,
                    layer='storage',
                    file=file,
                    desc=desc
                )

    def build_connections(self):
        """Build connection graph based on known relationships."""
        # Define connections (source -> targets)
        connections = {
            # Components -> Hooks
            'Dashboard': ['useSyncQueue', 'useAutoRefresh', 'SyncStatusIndicator'],
            'SyncStatusIndicator': ['useSyncQueue'],
            'ConversationList': ['useConversations'],
            'Contacts': ['contactService', 'contactBridge'],
            'Login': ['authService'],
            'MicrosoftLogin': ['authService'],

            # Hooks -> Services/Bridges
            'useAppStateMachine': ['useAutoRefresh', 'authService'],
            'useSyncQueue': ['SyncQueueService'],
            'useAutoRefresh': ['SyncQueueService', 'transactionBridge', 'messageBridge', 'contactBridge'],
            'useIPhoneSync': ['syncBridge'],
            'useConversations': ['messageBridge'],
            'useMacOSMessagesImport': ['messageBridge'],

            # Services -> Bridges
            'authService': ['authBridge'],
            'transactionService': ['transactionBridge'],
            'contactService': ['contactBridge'],
            'deviceService': ['deviceBridge'],

            # Bridges -> Handlers
            'syncBridge': ['syncHandlers'],
            'transactionBridge': ['transactionHandlers'],
            'contactBridge': ['contactHandlers'],
            'messageBridge': ['messageHandlers'],
            'authBridge': ['authHandlers'],
            'deviceBridge': ['deviceHandlers'],
            'llmBridge': ['llmHandlers'],

            # Handlers -> Backend Services
            'syncHandlers': ['syncOrchestrator', 'deviceDetectionService'],
            'transactionHandlers': ['gmailFetchService', 'outlookFetchService', 'databaseService'],
            'contactHandlers': ['databaseService'],
            'messageHandlers': ['macOSMessagesImport', 'databaseService'],
            'authHandlers': ['gmailFetchService', 'outlookFetchService', 'supabaseService', 'tokenEncryptionService'],
            'deviceHandlers': ['deviceDetectionService'],

            # Backend -> Backend/Storage
            'syncOrchestrator': ['deviceDetectionService', 'backupService', 'iOSMessagesParser', 'iPhoneSyncStorage'],
            'gmailFetchService': ['gmailApi', 'databaseService'],
            'outlookFetchService': ['graphApi', 'databaseService'],
            'deviceDetectionService': ['libimobiledevice'],
            'backupService': ['libimobiledevice'],
            'iOSMessagesParser': ['sqlite'],
            'macOSMessagesImport': ['sqlite'],
            'iPhoneSyncStorage': ['databaseService'],
            'databaseService': ['sqlite'],
            'supabaseService': ['supabase'],
        }

        for source, targets in connections.items():
            if source in self.nodes:
                self.nodes[source].connects = [t for t in targets if t in self.nodes]

    def scan_all(self):
        """Run all scans."""
        self.scan_components()
        self.scan_hooks()
        self.scan_frontend_services()
        self.scan_ipc_bridges()
        self.scan_handlers()
        self.scan_backend_services()
        self.scan_storage()
        self.build_connections()

    def to_json(self) -> str:
        """Convert nodes to JSON for the HTML template."""
        data = {}
        for id, node in self.nodes.items():
            data[id] = {
                'layer': node.layer,
                'file': node.file,
                'desc': node.desc,
                'connects': node.connects
            }
        return json.dumps(data, indent=2)

    def generate_html(self) -> str:
        """Generate the full HTML diagram."""
        nodes_json = self.to_json()

        # Group nodes by layer
        layers_html = ""
        for layer_id, layer_info in self.layers.items():
            layer_nodes = [n for n in self.nodes.values() if n.layer == layer_id]
            if not layer_nodes:
                continue

            nodes_html = ""
            for node in layer_nodes:
                nodes_html += f'''
          <div class="node" data-id="{node.id}" onclick="selectNode('{node.id}')">
            <div class="node-name">{node.name}</div>
            <div class="node-type">{node.file.split('/')[-1]}</div>
          </div>'''

            layers_html += f'''
      <div class="layer {layer_id}">
        <div class="layer-label">
          <div class="label-name">{layer_info['label']}</div>
          <div class="label-desc">{layer_info['desc']}</div>
        </div>
        <div class="layer-content">{nodes_html}
        </div>
      </div>
'''

        focus_title = f" ({self.focus.upper()} focus)" if self.focus else ""

        return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Magic Audit - Architecture Debugger{focus_title}</title>
  <style>
    :root {{
      --bg-dark: #0d1117;
      --bg-card: #161b22;
      --bg-hover: #21262d;
      --border: #30363d;
      --border-active: #58a6ff;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #484f58;
      --blue: #58a6ff;
      --green: #3fb950;
      --purple: #a371f7;
      --orange: #d29922;
      --red: #f85149;
      --cyan: #39c5cf;
      --pink: #db61a2;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-dark);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
    }}
    .sidebar {{
      width: 320px;
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      padding: 20px;
      overflow-y: auto;
      flex-shrink: 0;
    }}
    .sidebar h1 {{ font-size: 1.1rem; margin-bottom: 5px; color: var(--blue); }}
    .sidebar .subtitle {{ font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 20px; }}
    .chain-info {{ margin-top: 20px; }}
    .chain-info h3 {{ font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; color: var(--text-secondary); margin-bottom: 10px; }}
    .chain-step {{
      background: var(--bg-hover);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      font-size: 0.8rem;
    }}
    .chain-step.active {{ border-color: var(--blue); background: rgba(88, 166, 255, 0.1); }}
    .chain-step .step-layer {{ font-size: 0.65rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px; }}
    .chain-step .step-name {{ font-weight: 600; color: var(--text-primary); }}
    .chain-step .step-file {{ font-size: 0.7rem; color: var(--cyan); font-family: 'SF Mono', Monaco, monospace; margin-top: 4px; word-break: break-all; }}
    .chain-step .step-desc {{ font-size: 0.7rem; color: var(--text-secondary); margin-top: 4px; }}
    .chain-arrow {{ text-align: center; color: var(--text-muted); font-size: 0.8rem; margin: 4px 0; }}
    .no-selection {{ color: var(--text-secondary); font-size: 0.85rem; text-align: center; padding: 40px 20px; }}
    .legend {{ margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--border); }}
    .legend h4 {{ font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px; }}
    .legend-item {{ display: flex; align-items: center; gap: 8px; font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 6px; }}
    .legend-dot {{ width: 12px; height: 12px; border-radius: 3px; }}
    .main {{ flex: 1; padding: 30px; overflow: auto; }}
    .layers {{ display: flex; flex-direction: column; gap: 20px; max-width: 1400px; margin: 0 auto; }}
    .layer {{ display: flex; align-items: flex-start; gap: 20px; }}
    .layer-label {{ width: 120px; flex-shrink: 0; text-align: right; padding-top: 12px; }}
    .layer-label .label-name {{ font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }}
    .layer-label .label-desc {{ font-size: 0.65rem; color: var(--text-muted); margin-top: 2px; }}
    .layer-content {{ flex: 1; display: flex; flex-wrap: wrap; gap: 10px; }}
    .node {{
      background: var(--bg-card);
      border: 2px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      cursor: pointer;
      transition: all 0.2s ease;
      min-width: 140px;
    }}
    .node:hover {{ border-color: var(--text-secondary); transform: translateY(-2px); }}
    .node.highlighted {{ border-color: var(--blue); background: rgba(88, 166, 255, 0.15); box-shadow: 0 0 20px rgba(88, 166, 255, 0.3); z-index: 10; }}
    .node.dimmed {{ opacity: 0.3; }}
    .node.selected {{ border-color: var(--green); background: rgba(63, 185, 80, 0.15); box-shadow: 0 0 20px rgba(63, 185, 80, 0.3); }}
    .node .node-name {{ font-weight: 600; font-size: 0.85rem; margin-bottom: 4px; }}
    .node .node-type {{ font-size: 0.65rem; color: var(--text-muted); font-family: 'SF Mono', Monaco, monospace; }}
    .layer.components .layer-label .label-name {{ color: var(--green); }}
    .layer.components .node {{ border-left: 3px solid var(--green); }}
    .layer.hooks .layer-label .label-name {{ color: var(--cyan); }}
    .layer.hooks .node {{ border-left: 3px solid var(--cyan); }}
    .layer.services .layer-label .label-name {{ color: var(--purple); }}
    .layer.services .node {{ border-left: 3px solid var(--purple); }}
    .layer.ipc .layer-label .label-name {{ color: var(--orange); }}
    .layer.ipc .node {{ border-left: 3px solid var(--orange); }}
    .layer.handlers .layer-label .label-name {{ color: var(--pink); }}
    .layer.handlers .node {{ border-left: 3px solid var(--pink); }}
    .layer.backend .layer-label .label-name {{ color: var(--blue); }}
    .layer.backend .node {{ border-left: 3px solid var(--blue); }}
    .layer.storage .layer-label .label-name {{ color: var(--red); }}
    .layer.storage .node {{ border-left: 3px solid var(--red); }}
    .reset-btn {{
      background: var(--bg-hover);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }}
    .reset-btn:hover {{ border-color: var(--text-secondary); color: var(--text-primary); }}
    .instructions {{
      background: var(--bg-hover);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 15px 20px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 15px;
    }}
    .instructions-icon {{ font-size: 1.5rem; }}
    .instructions-text {{ font-size: 0.85rem; color: var(--text-secondary); }}
    .instructions-text strong {{ color: var(--text-primary); }}
    .generated-info {{ font-size: 0.7rem; color: var(--text-muted); margin-top: 15px; text-align: center; }}
  </style>
</head>
<body>
  <aside class="sidebar">
    <h1>Architecture Debugger</h1>
    <p class="subtitle">Click any component to trace its connections{focus_title}</p>
    <button class="reset-btn" onclick="resetSelection()">Reset View</button>
    <div class="chain-info" id="chainInfo">
      <div class="no-selection">Click on any component to see its full connection chain.</div>
    </div>
    <div class="legend">
      <h4>Layers</h4>
      <div class="legend-item"><div class="legend-dot" style="background: var(--green);"></div><span>React Components</span></div>
      <div class="legend-item"><div class="legend-dot" style="background: var(--cyan);"></div><span>Custom Hooks</span></div>
      <div class="legend-item"><div class="legend-dot" style="background: var(--purple);"></div><span>Frontend Services</span></div>
      <div class="legend-item"><div class="legend-dot" style="background: var(--orange);"></div><span>IPC Bridges</span></div>
      <div class="legend-item"><div class="legend-dot" style="background: var(--pink);"></div><span>Main Process Handlers</span></div>
      <div class="legend-item"><div class="legend-dot" style="background: var(--blue);"></div><span>Backend Services</span></div>
      <div class="legend-item"><div class="legend-dot" style="background: var(--red);"></div><span>Storage / External APIs</span></div>
    </div>
    <div class="generated-info">Auto-generated by /architecture skill</div>
  </aside>

  <main class="main">
    <div class="instructions">
      <span class="instructions-icon">🔍</span>
      <div class="instructions-text">
        <strong>Debug Mode:</strong> Click any node to trace the data flow from UI to database/API.
      </div>
    </div>
    <div class="layers" id="layers">
{layers_html}
    </div>
  </main>

  <script>
    const architecture = {nodes_json};

    let selectedNode = null;
    let highlightedNodes = new Set();

    function selectNode(nodeId) {{
      selectedNode = nodeId;
      highlightedNodes.clear();
      const chain = buildChain(nodeId);
      highlightedNodes = new Set(chain.map(step => step.id));
      updateNodeStyles();
      updateChainInfo(chain);
    }}

    function buildChain(startId) {{
      const chain = [];
      const visited = new Set();
      const layerOrder = ['components', 'hooks', 'services', 'ipc', 'handlers', 'backend', 'storage'];

      function traverseForward(id, depth = 0) {{
        if (visited.has(id) || !architecture[id]) return;
        visited.add(id);
        const node = architecture[id];
        chain.push({{ id, ...node, direction: depth === 0 ? 'origin' : 'downstream' }});
        for (const connId of node.connects || []) {{
          traverseForward(connId, depth + 1);
        }}
      }}

      function findUpstream(targetId) {{
        const upstream = [];
        for (const [id, node] of Object.entries(architecture)) {{
          if (node.connects && node.connects.includes(targetId)) {{
            upstream.push(id);
          }}
        }}
        return upstream;
      }}

      function traverseBackward(id) {{
        const upstreamIds = findUpstream(id);
        for (const upId of upstreamIds) {{
          if (!visited.has(upId) && architecture[upId]) {{
            visited.add(upId);
            const node = architecture[upId];
            chain.unshift({{ id: upId, ...node, direction: 'upstream' }});
            traverseBackward(upId);
          }}
        }}
      }}

      traverseForward(startId);
      traverseBackward(startId);
      chain.sort((a, b) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer));
      return chain;
    }}

    function updateNodeStyles() {{
      document.querySelectorAll('.node').forEach(node => {{
        const nodeId = node.dataset.id;
        node.classList.remove('highlighted', 'selected', 'dimmed');
        if (selectedNode) {{
          if (nodeId === selectedNode) {{
            node.classList.add('selected');
          }} else if (highlightedNodes.has(nodeId)) {{
            node.classList.add('highlighted');
          }} else {{
            node.classList.add('dimmed');
          }}
        }}
      }});
    }}

    function updateChainInfo(chain) {{
      const container = document.getElementById('chainInfo');
      if (chain.length === 0) {{
        container.innerHTML = '<div class="no-selection">Click on any component to see its full connection chain.</div>';
        return;
      }}
      let html = '<h3>Connection Chain</h3>';
      chain.forEach((step, index) => {{
        const isOrigin = step.direction === 'origin';
        html += `
          <div class="chain-step ${{isOrigin ? 'active' : ''}}">
            <div class="step-layer">${{step.layer}}</div>
            <div class="step-name">${{step.id}}</div>
            <div class="step-file">${{step.file}}</div>
            <div class="step-desc">${{step.desc}}</div>
          </div>
        `;
        if (index < chain.length - 1) {{
          html += '<div class="chain-arrow">↓</div>';
        }}
      }});
      container.innerHTML = html;
    }}

    function resetSelection() {{
      selectedNode = null;
      highlightedNodes.clear();
      updateNodeStyles();
      document.getElementById('chainInfo').innerHTML =
        '<div class="no-selection">Click on any component to see its full connection chain.</div>';
    }}
  </script>
</body>
</html>
'''

def main():
    parser = argparse.ArgumentParser(description='Generate architecture diagram')
    parser.add_argument('--focus', choices=['sync', 'auth', 'email'],
                        help='Focus on specific area')
    parser.add_argument('focus_arg', nargs='?', help='Focus area (alternative)')
    args = parser.parse_args()

    focus = args.focus or args.focus_arg

    scanner = ArchitectureScanner(focus=focus)
    scanner.scan_all()

    html = scanner.generate_html()

    # Generated output; gitignored (BACKLOG-4069)
    output_path = BASE_DIR / "docs" / "architecture" / "architecture-debug.html"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        f.write(html)

    print(f"✓ Generated architecture diagram: {output_path}")
    print(f"  Nodes: {len(scanner.nodes)}")
    if focus:
        print(f"  Focus: {focus}")

if __name__ == '__main__':
    main()
