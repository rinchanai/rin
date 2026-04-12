[English](README.md) | [Chinese](README.zh-CN.md) | [Japanese](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

Rin es un asistente local de IA, centrado en la terminal, que sigue siendo útil entre turnos.

Puede conversar, editar archivos, recordar preferencias duraderas, buscar en la web, ejecutar tareas programadas y conectarse a plataformas de chat mediante Koishi, todo detrás de una sola entrada: `rin`.

## Para qué sirve Rin

Rin está pensado para quienes quieren un asistente que permanezca en su flujo de trabajo diario, en lugar de abrir un agente desechable cada vez.

Úsalo cuando quieras:

- inspeccionar y modificar un repositorio desde la terminal
- mantener memoria estable y habilidades reutilizables
- programar recordatorios y comprobaciones recurrentes
- consultar información reciente sin salir del flujo de trabajo
- continuar con el mismo asistente desde la terminal y el chat

## Estado actual del proyecto

Rin ya es utilizable, pero sigue siendo un producto en refinamiento activo.

La dirección principal ya es estable:

- flujo de trabajo local-first
- memoria y recuperación integradas
- tareas programadas integradas
- búsqueda web y fetch integrados
- soporte para el puente de chat con Koishi
- una ruta consistente de instalación, ejecución y actualización

Aun así, la fiabilidad, la UX y la documentación siguen en proceso de pulido. Si lo pruebas hoy, piensa en un producto en evolución, no en una plataforma congelada.

## Inicio rápido

Instalación:

```bash
./install.sh
```

Abrir Rin:

```bash
rin
```

Comprobar el estado si hace falta:

```bash
rin doctor
```

## Comandos principales

```bash
rin            # abrir Rin
rin doctor     # revisar estado y configuración
rin start      # iniciar el daemon
rin stop       # detener el daemon
rin restart    # reiniciar el daemon
rin update     # actualizar el runtime instalado de Rin
```

## Qué puedes pedirle a Rin

Ejemplos:

- `Revisa este directorio y dime qué es importante.`
- `Reescribe este README.`
- `Ordena este archivo de configuración.`
- `Recuerda que prefiero respuestas cortas.`
- `Recuérdame mañana por la tarde que revise los logs.`
- `Busca la documentación oficial más reciente de esta herramienta.`
- `Vigila esta carpeta cada hora y avísame si cambia algo.`

## Capacidades integradas

Rin incluye por defecto:

- memoria y recuperación a largo plazo
- tareas programadas y recordatorios
- búsqueda web en vivo
- fetch directo de URLs
- subagentes
- puente de chat con Koishi

## Actualizar Rin

Para un runtime instalado normal, usa:

```bash
rin update
```

Si `rin` no existe en la cuenta actual, no asumas que Rin no está instalado. A menudo solo significa que el usuario actual de la shell no es el dueño del launcher.

Para el flujo completo de recuperación o actualización, consulta:

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)

## Documentación

Documentación para usuarios:

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`docs/architecture.md`](docs/architecture.md)

Documentación para agent / runtime:

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/docs/capabilities.md`](docs/rin/docs/capabilities.md)
- [`docs/rin/docs/runtime-layout.md`](docs/rin/docs/runtime-layout.md)
- [`docs/rin/docs/builtin-extensions.md`](docs/rin/docs/builtin-extensions.md)

## Versión corta

Instálalo, ejecuta `rin` y mantén al asistente dentro de tu flujo de trabajo.

Ese es el núcleo de Rin.
