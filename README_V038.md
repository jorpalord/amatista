# Universal Agent Studio V0.3.8

## Corrección del “hola y nada”

Codex sí podía estar conectado, pero Universal Agent solo leía:

```ts
params.delta
```

El app-server puede entregar el texto como:

```ts
params.text
params.content
params.message
```

V0.3.8 acepta todas esas variantes.

También acepta:

```ts
itemId
item_id
id
```

y procesa `item/completed` como fallback si el texto final llega ahí.

## Modelo/dropdown

El selector de modelo ahora tiene z-index superior y se abre por encima del composer fijo.

## Prueba rápida

```powershell
npm run typecheck
npm run dev
```

Luego:

1. selecciona workspace;
2. confirma que Codex está conectado;
3. escribe `hola`;
4. debe aparecer la respuesta del agente;
5. abre selector de modelos y verifica que queda arriba del composer.
