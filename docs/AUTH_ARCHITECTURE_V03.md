# V0.3 - Arquitectura de autenticación

## Regla

Proveedor != modelo != autenticación != runtime.

Ejemplos:

```text
OpenAI / Codex
  auth: subscription
  runtime: codex-subscription
```

```text
Microsoft Foundry
  auth: api-key
  runtime: foundry
```

```text
Anthropic / Claude
  auth: subscription
  runtime: claude-subscription
```

```text
Google
  auth: api-key
  runtime: native-api
```

## Codex subscription

Reutiliza el estado oficial de `codex` CLI.

No se automatiza chatgpt.com.
No se extraen cookies.
No se guarda token manualmente.

## API key

Las claves persistidas por la app se cifran con `safeStorage`.

## Claude subscription

V0.3 solo detecta CLI y registra configuración.
V0.4 debe implementar un bridge real con streaming y tools.

## Gemini

V0.3 no presupone reutilización de una suscripción web.
Se mantiene como API/native pendiente.
