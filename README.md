# omp-discord

Extensión nativa de **Discord Rich Presence** para **Oh My Pi (`omp`)** sin dependencias externas.

Muestra automáticamente en tu estado de Discord cuando estás programando con `omp`:
- **Proyecto actual** (`cwd`)
- **Actividad en tiempo real** (*Pensando...*, *Editando `archivo.ts`*, *Leyendo `archivo.ts`*, *Ejecutando comando*, *Explorando el código*, *Coordinando subagentes*, *En espera*)
- **Modelo activo** (ej. `gemini-4-argon`, `claude-sonnet-4`)
- **Tiempo de sesión transcurrido**
- **Ocultación automática en inactividad (Idle)** tras 10 minutos sin actividad (configurable)

## Instalación

### Opción 1: Instalación global en `~/.omp/agent/extensions/`
Enlaza o copia este directorio dentro de `~/.omp/agent/extensions/omp-discord`:

```bash
# En Windows (PowerShell)
New-Item -ItemType Junction -Path "$HOME\.omp\agent\extensions\omp-discord" -Target (Get-Location).Path

# En Linux / macOS
ln -s "$(pwd)" ~/.omp/agent/extensions/omp-discord
```

### Opción 2: Cargar por CLI en una sesión puntual
```bash
omp --extension ./src/index.ts
```

## Comandos dentro de `omp`

- `/discord` o `/discord status`: Muestra estado de conexión IPC y configuración actual.
- `/discord on` | `/discord off`: Activa o desactiva la presencia en Discord en caliente.
- `/discord privacy <full|moderate|private>`:
  - `full` (por defecto): Muestra proyecto, archivo/herramienta actual y modelo.
  - `moderate`: Muestra proyecto y modelo, ocultando nombres de archivos/herramientas.
  - `private`: Muestra únicamente `"Programando con omp"` y el tiempo transcurrido.
- `/discord idle <minutos>`: Define cuántos minutos esperar en estado inactivo antes de ocultar la presencia (`0` para no ocultar nunca).
- `/discord client-id <id>`: Configura tu propio Application ID de Discord Developer Portal (por ejemplo, si creas una App llamada **"Oh My Pi"** para personalizar el título *"Jugando a Oh My Pi"* y los íconos).

## Configuración y Variables de Entorno

La configuración se guarda automáticamente en `~/.omp/agent/discord-presence.json`:

```json
{
  "enabled": true,
  "clientId": "782685898163617802",
  "privacy": "full",
  "showProject": true,
  "showDetails": true,
  "showModel": true,
  "idleTimeoutMinutes": 10,
  "largeImageKey": "code",
  "largeImageText": "Oh My Pi (omp)"
}
```

Variables de entorno soportadas (tienen prioridad sobre el archivo):
- `OMP_DISCORD_CLIENT_ID`: Sobrescribe el Client ID de Discord.
- `OMP_DISCORD_ENABLED`: `true`/`1` o `false`/`0`.
- `OMP_DISCORD_PRIVACY`: `full`, `moderate` o `private`.

## Desarrollo y Tests

```bash
bun test
```
