---
name: project-conventions
description: >-
  Convenciones de código de acp-pi: ESM sin build, node:test, puente sin estado
  propio y manejo de errores del hijo. Trigger: escribir o revisar código del
  proyecto, agregar un archivo nuevo, o decidir dónde va una dependencia.
---

# Convenciones de acp-pi

## Forma del proyecto

- **ESM puro, sin build.** `.mjs`, `import`/`export`, sin transpilador ni bundler. Lo que corre en
  desarrollo es lo que se publica.
- **Node ≥ 22.19.0** (el mismo piso que pide Pi). Sin `require`, sin `__dirname`.
- **Dependencias mínimas.** Node trae `node:test`, `node:assert`, `node:child_process`. Una
  dependencia nueva necesita justificación en el PR; el puente en sí no debería necesitar casi nada.
- **Sin `node_modules` en el paquete**: `files` en `package.json` acota qué se publica.

## Estructura

```
bin/acp-pi.mjs      punto de entrada: parsea flags, abre el puente
lib/                lógica: protocolo ACP, transporte Pi, traducción
test/               node:test, un archivo por unidad
docs/design.md      el contrato que se implementa
odd/tasks/          especificación y bitácora del trabajo
```

## Reglas de diseño

1. **El puente no guarda estado del agente.** Si necesita saber algo del turno, lo pregunta a Pi. Un
   puente con estado propio se desincroniza en la primera cancelación.
2. **Todo fallo se propaga.** Ninguna promesa queda sin resolver: un error del hijo, un timeout o una
   respuesta inválida terminan en un error explícito de la request ACP pendiente.
3. **No se amplía el workspace.** El `cwd` del hijo es el que pidió el cliente, punto.
4. **Los permisos no se auto-aprueban.** Si no hay forma de preguntar, se rechaza.

## Tests

- `node --test test/` — sin frameworks.
- Los casos límite que importan: proceso hijo que muere a mitad de turno, cancelación seguida de otro
  prompt, permiso denegado, y un turno que termina sin producir texto.
- Un test que necesite red o un `pi` real se marca y se documenta; los unitarios deben correr en
  segundos y sin dependencias externas.

## Commits y ramas

Ver la skill `branch-and-commit-discipline`: rama corta, Conventional Commits en inglés, commit a
medida, push y merge los decide el dueño.
