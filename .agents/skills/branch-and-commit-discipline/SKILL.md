---
name: branch-and-commit-discipline
description: >-
  Trabajar siempre en una rama y commitear a medida que se avanza, nunca sobre
  main ni dejando cambios sueltos en el árbol. Trigger: cualquier cambio de
  código, feature, fix o refactor en un repo del proyecto; también al terminar
  una tarea antes de reportarla como hecha.
---

# Disciplina de ramas y commits

Regla del dueño, textual: **«trabajar siempre en ramas por protección y
seguridad e ir commiteando siempre a medida que se van haciendo cosas»**.

El objetivo no es burocracia: es que ningún trabajo quede sólo en el árbol de
trabajo, donde un comando equivocado lo borra y nadie puede revisarlo por
separado.

## Modelo de ramas: Git Flow simplificado (decidido por el dueño)

Sin rama `develop`. `main` es la única rama permanente y se mantiene siempre
publicable.

- **`main`**: lo que está en producción. **Nunca** recibe commits directos.
- **Ramas cortas** por unidad de trabajo, creadas desde `main` y mergeadas a
  `main` por PR: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`, `test/…`.
- **`hotfix/…`** para un arreglo urgente sobre producción: sale de `main`, se
  mergea a `main` y se tagea enseguida.
- **Releases**: se tagean desde `main` con semver (`v1.4.0`). No hay ramas
  `release/*`; el tag es el release.
- **PR obligatorio** antes de mergear a `main`, incluso trabajando solo: el PR
  es donde queda el diff revisable y el registro de qué se verificó.
- Un tema por rama. Si aparece un arreglo no relacionado, va en otra rama.
- Si la rama va a convivir con trabajo en curso en otra, usar un worktree
  aislado (`git worktree add`) en vez de cambiar de rama a mitad de tarea.

## Conventional Commits, verificado

El repo trae un hook en `.githooks/commit-msg` que rechaza cualquier mensaje que
no cumpla `tipo(alcance)!: descripción`. Se activa una vez por clon:

```sh
git config core.hooksPath .githooks
```

Tipos aceptados: `feat fix docs style refactor perf test build ci chore revert`.
Se exceptúan los que no escribe una persona (`Merge …`, `Revert …`, `fixup!`,
`squash!`, `amend!`). La primera línea no puede pasar de 100 caracteres ni
terminar en punto.

Si el hook no está activo, `git config core.hooksPath` lo delata: vacío significa
que este clon no está protegido.

## Commits

- **Commitear a medida**, no al final. Cada unidad de trabajo verificable es un
  commit: código + sus tests + los docs que lo describen, juntos.
- Antes de cada commit: los tests del área tocada en verde. Si están en rojo, no
  se commitea (se arregla o se deja el trabajo sin commitear y se avisa).
- El **cuerpo** del mensaje es la memoria técnica del proyecto: qué síntoma
  había, qué se cambió, y los números que lo respaldan. La primera línea dice el
  qué; el cuerpo dice el por qué.
- Tamaño: si un commit supera ~400 líneas cambiadas, partirlo. Un commit que
  mezcla dos temas distintos no se puede revisar ni revertir por separado.
- Si un cambio es riesgoso o irreversible, va en su **propio commit**, para que
  se pueda revisar y revertir solo.

## Ramas: lo mínimo

- **Nunca commits sobre la rama por defecto** (`main`, `master`). Antes del
  primer commit: `git switch -c <tipo>/<tema-corto>`.
- Nombres en kebab-case, cortos y en el mismo vocabulario que los commits.

## Antes de cada commit (checklist)

1. `git status` — revisar qué entra. **Nada de artefactos**: WAVs de prueba,
   directorios de scratch, `.env`, claves, dumps de `/tmp` copiados al repo.
2. `git diff --stat` — que el tamaño y los archivos sean los esperados para el
   tema del commit.
3. Tests del área en verde.
4. Que no queden `eprintln!`/`console.log` de debug en el código final.
5. Que no haya cambios de otro tema colados (staging selectivo con `git add -p`
   o por archivo, nunca `git add -A` a ciegas cuando hay trabajo mezclado).

## Cierre de una tarea

- Al terminar: el trabajo está en commits, no en el árbol. `git status` limpio
  salvo lo que se reporte explícitamente como pendiente.
- **Push, PR y merge son decisión del dueño**, no del agente: se ofrece, no se
  asume.
- Reportar siempre: rama, commits (hash + título), tests que se corrieron y su
  resultado, y qué quedó fuera de commit y por qué.

## Errores que esta regla evita (vistos en este proyecto)

- Acumular más de mil líneas sin commitear en quince archivos, donde un
  `git checkout` accidental borraba días de trabajo.
- Mezclar en un mismo cambio el arreglo de un bug, una feature y un refactor,
  imposibilitando revertir sólo lo que falló.
- Dejar archivos basura (`bass.wav`, `drums.wav`) generados por un ejemplo en la
  raíz del repo, listos para colarse en un commit con `git add -A`.
