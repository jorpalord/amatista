# Arquitectura V0.2

Regla central:

```text
Modelo != Proveedor != Credencial != Runtime != Workspace
```

```text
UI tipo Codex
   |
AgentRuntime
   |-- CodexRuntime (actual)
   `-- NativeAgentRuntime (V0.3)
   |
ProviderRegistry
   |-- Foundry
   |-- OpenAI
   |-- Anthropic
   |-- Google
   |-- OpenAI-compatible
   `-- Web experimental
```

Las herramientas futuras pertenecen al entorno, no al modelo:

```text
ToolRegistry
FileRead | FileWrite | ApplyPatch | Shell | Git | Web | Browser | MCP | Skills
```
