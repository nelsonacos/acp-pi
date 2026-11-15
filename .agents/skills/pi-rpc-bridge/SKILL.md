---
name: pi-rpc-bridge
description: >-
  Contrato de Pi en modo RPC y cómo puentearlo con un protocolo externo: JSONL
  sobre stdio, comandos, eventos y el ciclo hasta agent_settled. Trigger:
  lanzar `pi --mode rpc`, parsear sus eventos, traducir un prompt o una
  cancelación, o depurar por qué el puente se cuelga esperando una respuesta.
---

# Pi en modo RPC

```sh
pi --mode rpc --no-session
```

- **Un objeto JSON por línea.** No es JSON-RPC: no hay `id`/`method`/`params`. Escribís un objeto en
  stdin, leés objetos por stdout.
- El proceso es **longevo**: atiende varios turnos hasta que lo cerrás.

## Comandos que importan

| comando | para qué |
|---|---|
| `{"type":"prompt","message":...}` | un turno del usuario |
| `{"type":"new_session"}` | sesión nueva |
| `{"type":"switch_session", ...}` | retomar otra sesión |
| `{"type":"get_state"}` | estado actual (modelo, sesión) |
| `{"type":"get_messages"}` | historial |
| `{"type":"set_model", ...}` | cambiar de modelo |

La lista completa está en la documentación de Pi (`docs/rpc-commands.md`), no la inventes.

## Eventos

Llegan por stdout mientras el turno corre y terminan en **`agent_settled`**: ese es el marcador de
fin de turno. Cualquier espera posterior a un `agent_settled` es un bug del puente.

## Reglas del puente

1. **Un proceso por sesión**, con `cwd` igual al workspace pedido. No reutilices un hijo entre
   workspaces distintos.
2. **No traduzcas de más.** El puente reenvía y adapta; no reescribe prompts ni filtra eventos.
3. **Cancelación**: cortar el turno no debe matar el proceso. Si no hay comando de cancelación
   disponible, la salida es reiniciar el hijo y reportar la sesión como reiniciada — nunca fingir
   que se canceló.
4. **Crash del hijo**: toda request pendiente falla con error explícito. Nunca dejar el cliente
   esperando.
5. **Permisos**: si Pi pide confirmación por una vía que el modo RPC no expone, el puente **no puede
   aprobar por su cuenta**. Se reporta como no soportado o se propaga al cliente.

## Precedente en el propio producto

La app de escritorio de Gentle Shell gobierna Pi así: setea `GENTLE_SHELL_INTERACTIVE_HOST` sobre el
proceso lanzado con `--mode rpc` para responder diálogos y publicar estado de subagentes. Ese
mecanismo es la referencia de cómo se espera que un cliente externo hable con Pi.
