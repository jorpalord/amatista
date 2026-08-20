# q_config.yaml import plan

Campos usados:

- `azure.endpoint` -> Microsoft Foundry endpoint
- `azure.api_key` -> Microsoft Foundry API key, guardada cifrada por Electron
- `azure.model` -> Foundry chat deployment
- `azure.coder_model` -> Foundry coder deployment
- `azure.claude_endpoint` / `azure.claude_model` -> Azure Claude detectado, desactivado por defecto
- `groq.api_key` / `groq.stt_model` -> Groq detectado, desactivado por defecto
- `llm.base_url` / `llm.model` -> Ollama local detectado, desactivado por defecto

No se incluyen valores secretos en este documento.
