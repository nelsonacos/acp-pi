---
name: acp-protocol
description: >-
  Contrato real del Agent Client Protocol para implementar el servidor: métodos
  JSON-RPC, ciclo de vida de sesión, streaming de updates y pedidos de permiso.
  Trigger: implementar, revisar o depurar cualquier parte del lado agente de ACP
  (initialize, session/new, session/prompt, session/cancel, session/update,
  request_permission), o cuando el cliente rechaza el handshake.
---

# ACP del lado agente

ACP es **JSON-RPC 2.0 sobre stdio**. El cliente lanza el proceso agente y le habla por stdin/stdout.
No hay HTTP, no hay socket, no hay framing más allá del JSON-RPC.

## Ciclo de vida mínimo

1. **`initialize`** — el cliente manda versión de protocolo y sus capacidades; el agente responde las
   suyas. Si las versiones no son compatibles, se responde error y se corta limpio. No inventes
   capacidades: si no implementás `fs/*` o `terminal/*`, no las declares.
2. **`session/new`** — el cliente pide una sesión con un `cwd` (workspace). El agente responde un
   `sessionId`. Ese `cwd` es el límite del agente: nada fuera de ahí.
3. **`session/prompt`** — un turno del usuario. La respuesta llega **en streaming** por
   notificaciones `session/update`, no como retorno de la request. La request se resuelve cuando el
   turno termina.
4. **`session/cancel`** — corta el turno en curso. La sesión sigue viva.
5. **`session/request_permission`** — el agente pide aprobación para ejecutar algo. El cliente
   responde una opción de las ofrecidas. Un "deny" debe impedir la ejecución: nunca auto-aprobar.

## Streaming

Las notificaciones `session/update` son la parte que más se implementa mal. Deben emitirse a medida
que el agente produce contenido — texto del asistente, inicio y actualización de tool calls, planes —
no acumularse hasta el final. Un cliente que no ve nada hasta el cierre parece colgado.

## Errores

- Un error del agente durante un turno se devuelve como error de **esa request**, no como cierre del
  proceso.
- Si el proceso hijo muere, todas las requests pendientes fallan con error explícito. Nunca dejar
  una request sin resolver: el cliente se cuelga.

## Lo que este proyecto NO implementa (por diseño)

- `fs/read_text_file`, `fs/write_text_file`: Pi trabaja con sus propias herramientas.
- `terminal/*`: idem.
- Autenticación a proveedores: no es responsabilidad del puente.

## Regla de oro

El protocolo es un contrato, no una sugerencia. Si un caso no se puede mapear fielmente —por ejemplo
un permiso que Pi resuelve por una vía que no expone— la respuesta correcta es **rechazar o fallar
explícitamente**, no aproximar en silencio.
