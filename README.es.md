[English](README.md) | [Chinese](README.zh-CN.md) | [Japanese](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

Un asistente local de IA, centrado en la terminal, que puede conversar, editar archivos, recordar cosas, buscar en la web y ejecutar tareas programadas.

## Qué es Rin

Rin no está pensado solo para sesiones aisladas con un agente de código.

La idea es tener un asistente local que puedas mantener en tu terminal para el trabajo diario:

- pedir cosas en lenguaje natural
- inspeccionar y modificar archivos
- conservar memoria útil a largo plazo
- programar recordatorios y tareas recurrentes
- consultar información reciente en la web
- conectar el mismo asistente a plataformas de chat mediante Koishi

El objetivo es simple: que el agente se sienta como una herramienta con la que realmente puedas convivir, no solo como una capa alrededor de un modelo.

## Por qué Rin

Rin se centra en unas pocas bases:

- flujo de trabajo orientado a la terminal
- memoria integrada, no solo chats sin estado
- tareas programadas integradas
- búsqueda web integrada para preguntas sensibles al tiempo
- soporte de puente de chat mediante Koishi
- un único punto de entrada del producto: `rin`

Si quieres un asistente que siga siendo útil con el tiempo, Rin está diseñado para eso.

## Inicio rápido

Instalación:

```bash
./install.sh
```

Luego abre Rin:

```bash
rin
```

Comprueba el estado si hace falta:

```bash
rin doctor
```

El instalador te advertirá sobre los límites de seguridad y el posible uso adicional de tokens. Ese coste extra puede venir de la inicialización, el procesamiento de memoria, los resúmenes, los subagentes, las tareas programadas y la búsqueda web.

## Qué puedes pedirle a Rin

Cuando Rin esté abierto, simplemente háblale.

Ejemplos:

- `Revisa este directorio y dime qué es importante.`
- `Reescribe este README.`
- `Ordena este archivo de configuración.`
- `Recuerda que prefiero respuestas cortas.`
- `Recuérdame mañana por la tarde que revise los logs.`
- `Busca la documentación oficial más reciente de esta herramienta.`
- `Vigila esta carpeta cada hora y avísame si cambia algo.`

## Comandos principales

```bash
rin            # abrir Rin
rin doctor     # revisar estado y configuración
rin start      # iniciar el daemon
rin stop       # detener el daemon
rin restart    # reiniciar el daemon
rin update     # actualizar Rin
```

## Capacidades integradas clave

Rin ya trae conectadas varias funciones importantes:

- memoria a largo plazo
- tareas programadas y recordatorios
- búsqueda web en vivo
- puente de chat con Koishi
- subagentes para delegar trabajo

## Cuándo usar `rin --std`

Lo normal es usar `rin`.

`rin --std` es sobre todo una alternativa de diagnóstico cuando el modo RPC por defecto tiene problemas y necesitas una sesión en primer plano para recuperar o depurar.

## Documentación

Si quieres más detalles, empieza aquí:

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/capabilities.md`](docs/rin/capabilities.md)
- [`docs/rin/runtime-layout.md`](docs/rin/runtime-layout.md)
- [`docs/rin/builtin-extensions.md`](docs/rin/builtin-extensions.md)

## Versión corta

Instálalo, ejecuta `rin` y pídele lo que necesites.

Esa es la idea principal de Rin.
