# acp-pi: ACP server for Pi

El dueño quiere manejar gentle-shell desde un cliente externo. Los clientes ACP (Happy es el caso
concreto) solo hablan **ACP**; Pi habla **RPC JSONL**. Falta el puente.

Nombre elegido: **`acp-pi`** (libre en npm; `pi-acp` está tomado por un paquete ajeno).

## Specs

- **S1**: un cliente ACP puede crear una sesión, mandar un prompt y recibir la respuesta en
  **streaming**, sobre un workspace elegido por el cliente.
- **S2**: cancelar una sesión corta el turno en curso y deja la sesión usable para el siguiente
  prompt.
- **S3**: un pedido de permiso de Pi se traduce a `session/request_permission`; si el cliente
  responde "deny" la herramienta **no se ejecuta**. Nunca se auto-aprueba.
- **S4**: un crash del proceso Pi se convierte en un error ACP sobre la request pendiente, nunca en
  un cuelgue.
- **S5**: el proceso Pi corre con `cwd` igual al workspace declarado por el cliente, y el puente
  nunca lo amplía.
- **S6**: publicable en el Gentle Hub (topic `gentle-shell-package` + `gentle-shell-extension`) y en
  `pi.dev/packages` (keyword `pi-package`), con README que explique la instalación.

## Tasks

- **T1** (S1) Esqueleto del proceso: parsear `--workspace`, levantar el hijo con
  `pi --mode rpc --no-session`, handshake `initialize` y cerrar limpio en EOF.
- **T2** (S1) `session/new` + `session/prompt`: escribir el prompt, reenviar deltas como
  `session/update`, cerrar el turno en `agent_settled`.
- **T3** (S2) `session/cancel` con verificación de que la sesión sigue viva.
- **T4** (S3) Round trip de permisos, con el caso "deny" verificado.
- **T5** (S4) Errores y crash del hijo.
- **T6** (S6) README final, topics del repo y alta en el hub.

## Log

- **L1** (dueño, literal): «ok habia quedado pendiente tambien la investigacion de gentle hub»
- **L2** (dueño, literal): «ijiciemos el proyecto de acp dslextu el nombre al proyecto»
- **L3** (evidencia): el hub se alimenta del topic `gentle-shell-package` en repos públicos y su
  snapshot está en `https://gentlemanprogramming.com/data/gentle-hub.json` (131 entradas al
  2026-11-15).
- **L4** (evidencia): Pi expone `GENTLE_SHELL_INTERACTIVE_HOST` para que la app de escritorio lo
  gobierne por `--mode rpc`; el patrón de cliente externo ya existe en el producto.
- **L5** (evidencia): `@zed-industries/agent-client-protocol` 0.4.5 es el SDK ACP publicado.
- **L6** (decisión): commits y documentación técnica en inglés (convención del ecosistema);
  conversación con el dueño en español.
- **L7** (evidencia): el framing ACP real es NDJSON — un objeto JSON-RPC por línea terminado en
  `\n`, sin cabeceras `Content-Length`. El SDK `@zed-industries/agent-client-protocol` 0.4.5 lo
  resuelve para el lado agente con `ndJsonStream` + `AgentSideConnection`; el puente no maneja el
  framing a mano.
- **L8** (evidencia): `pi --mode rpc --no-session` real (pi-coding-agent 1.5.0) no emite evento
  "ready": emite `extension_ui_request` al arrancar y la prueba de readiness es el `response` de
  `get_state` (que trae `sessionId`). Un `prompt` emite `message_start` → `message_update`
  (`text_delta`) → `message_end` → `turn_end` → `agent_end` → `agent_settled`; `agent_settled`
  marca fin de turno.
