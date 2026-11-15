---
name: pi-package-publishing
description: >-
  Publicar el proyecto en el ecosistema Pi y en el Gentle Hub: keyword y
  manifiesto del paquete, topics de GitHub, smoke test de instalación y alta en
  el snapshot. Trigger: publicar una versión, aparecer en el hub, o preparar el
  paquete para que `pi install` funcione.
---

# Publicar en el ecosistema

Son **dos circuitos distintos** y conviene estar en los dos.

| | Pi package gallery | Gentle Hub |
|---|---|---|
| URL | `pi.dev/packages` | `gentlemanprogramming.com/gentle-hub` |
| se entra con | keyword **`pi-package`** en `package.json` | topic **`gentle-shell-package`** en el repo público |
| qué muestra | paquete npm instalable | repo de GitHub con estrellas y README |
| instalación | `pi install npm:acp-pi` | la que documente el README |

## Antes de publicar

1. **`package.json` completo**: `name`, `version`, `description`, `license`, `engines` (Pi pide Node
   ≥22.19.0), `files` acotado —nada de publicar `node_modules` ni tests—, `bin` si es ejecutable.
2. **README = ficha del producto.** En el hub, `instruction_url` apunta al README de 131 de 131
   entradas: no hay descripción aparte. Tiene que decir qué es, cómo se instala y cómo se usa, en las
   primeras pantallas.
3. **Smoke test de instalación** desde un directorio limpio, con `npm pack` y el tarball, no desde el
   árbol de trabajo: un `files` mal armado se descubre ahí, no en producción.
4. **Sin secretos** en el paquete: revisar el tarball, no el `.gitignore`.

## Publicar

```sh
npm publish --access public
```

Después, en el repo de GitHub:

- topic `gentle-shell-package` (recurso de Shell) o `gentle-hub-project` (proyecto comunitario);
- topics de subtipo si aplica: `gentle-shell-extension`, `-theme`, `-skill`, `-prompt`.

No hay revisión ni formulario: la página del hub dice explícitamente que listar no es endosar. La
indexación **no tiene cronograma prometido**, así que la aparición puede tardar días.

## Verificar que entró

El snapshot es público:

```sh
curl -sL https://gentlemanprogramming.com/data/gentle-hub.json | \
  node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));' 2>/dev/null || \
curl -sL https://gentlemanprogramming.com/data/gentle-hub.json | grep -o '"name":"acp-pi"'
```

`synced_at` en la raíz dice cuándo se generó el snapshot: si tu repo no aparece y `synced_at` es
anterior al topic, falta esperar la próxima sincronización.
